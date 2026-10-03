import { createServer as createHttpServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { loadConfig, getPlan, isCryptoReady, isStarsReady } from './src/config.mjs';
import { createDatabase } from './src/database.mjs';
import { CryptoPayClient } from './src/crypto-pay.mjs';
import { MarzbanClient } from './src/marzban.mjs';
import { createSecret, hashSecret, validateTelegramInitData, verifyCryptoPaySignature } from './src/security.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86400000;
const MAX_BODY_BYTES = 32768;
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

async function readRawBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(raw) {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON');
  }
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function decimalEqual(left, right) {
  const normalize = (value) => {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
    if (!match) return null;
    const fractional = (match[2] || '').replace(/0+$/, '');
    return `${match[1]}${fractional ? `.${fractional}` : ''}`;
  };
  const normalizedLeft = normalize(left);
  return normalizedLeft !== null && normalizedLeft === normalize(right);
}

function rateLimiter({ windowMs, max }) {
  const clients = new Map();
  return (key) => {
    const now = Date.now();
    const entry = clients.get(key);
    if (!entry || entry.resetAt <= now) {
      clients.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= max) return false;
    entry.count += 1;
    return true;
  };
}

function readCookie(request, name) {
  const raw = request.headers.cookie || '';
  for (const item of raw.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    return item.slice(separator + 1).trim();
  }
  return null;
}

function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "connect-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org"
  ].join('; ');
}

export function createVphServer({
  config = loadConfig(),
  db = createDatabase(config.databasePath),
  fetchImpl = fetch
} = {}) {
  const marzban = new MarzbanClient(config.marzban, fetchImpl);
  const cryptoPay = new CryptoPayClient({
    token: config.cryptoPayToken,
    baseUrl: config.cryptoPayBaseUrl
  }, fetchImpl);
  const allowCheckout = rateLimiter({ windowMs: 60000, max: 8 });
  const fulfillmentLocks = new Map();

  async function botApi(method, body) {
    const response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json();
    if (!response.ok || result?.ok !== true) {
      throw new Error(`Telegram ${method} failed (${response.status})`);
    }
    return result.result;
  }

  function getTelegramUser(request) {
    if (!config.botToken) throw new HttpError(503, 'TELEGRAM_NOT_CONFIGURED');
    const authorization = request.headers.authorization || '';
    if (!authorization.startsWith('tma ')) throw new HttpError(401, 'TELEGRAM_AUTH_REQUIRED');
    try {
      return validateTelegramInitData(authorization.slice(4), config.botToken);
    } catch {
      throw new HttpError(401, 'TELEGRAM_AUTH_INVALID');
    }
  }

  function requireSameOrigin(request) {
    const expectedOrigin = config.cryptoBaseUrl && new URL(config.cryptoBaseUrl).origin;
    if (!expectedOrigin || request.headers.origin !== expectedOrigin) {
      throw new HttpError(403, 'SAME_ORIGIN_REQUIRED');
    }
  }

  function requireCryptoHost(request) {
    const expectedHost = config.cryptoBaseUrl && new URL(config.cryptoBaseUrl).host;
    if (!expectedHost || request.headers.host?.toLowerCase() !== expectedHost.toLowerCase()) {
      throw new HttpError(404, 'NOT_FOUND');
    }
  }

  function getOrder(id) {
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) || null;
  }

  function getCryptoCustomer(request) {
    const token = readCookie(request, 'vph_customer');
    if (!token) return null;
    return db.prepare('SELECT * FROM crypto_customers WHERE session_token_hash = ?')
      .get(hashSecret(token)) || null;
  }

  async function fulfillOrder(orderId) {
    const order = getOrder(orderId);
    if (!order) throw new Error('Paid order was not found');
    const accountKey = order.account_id;
    const previous = fulfillmentLocks.get(accountKey) || Promise.resolve();
    const operation = previous.then(
      () => performOrderFulfillment(orderId),
      () => performOrderFulfillment(orderId)
    );
    fulfillmentLocks.set(accountKey, operation);
    try {
      return await operation;
    } finally {
      if (fulfillmentLocks.get(accountKey) === operation) fulfillmentLocks.delete(accountKey);
    }
  }

  async function performOrderFulfillment(orderId) {
    const order = getOrder(orderId);
    if (!order) throw new Error('Paid order was not found');
    if (order.status === 'fulfilled') return order;
    if (!['paid', 'provisioning', 'provisioning_failed'].includes(order.status)) {
      throw new Error(`Cannot provision order in state ${order.status}`);
    }

    db.prepare(`
      UPDATE orders
      SET status = 'provisioning', error_code = NULL
      WHERE id = ? AND status IN ('paid', 'provisioning', 'provisioning_failed')
    `).run(orderId);

    try {
      let targetExpiresAt = order.target_expires_at;
      if (!targetExpiresAt) {
        const [existingUser, account] = await Promise.all([
          marzban.getUser(order.vpn_username),
          Promise.resolve(db.prepare(
            'SELECT expires_at FROM accounts WHERE account_id = ?'
          ).get(order.account_id))
        ]);
        const remoteExpiry = Number(existingUser?.expire || 0) * 1000;
        if (existingUser && !remoteExpiry) {
          throw new Error('Existing Marzban user has no expiry; refusing to shorten an unlimited account');
        }
        const base = Math.max(
          Date.now(),
          account?.expires_at || 0,
          remoteExpiry
        );
        targetExpiresAt = base + order.plan_days * DAY_MS;
        db.prepare('UPDATE orders SET target_expires_at = ? WHERE id = ? AND target_expires_at IS NULL')
          .run(targetExpiresAt, orderId);
        targetExpiresAt = getOrder(orderId).target_expires_at;
      }

      const result = await marzban.provision({
        username: order.vpn_username,
        days: order.plan_days,
        targetExpiresAt,
        accountId: order.account_id
      });
      const now = Date.now();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`
          INSERT INTO accounts (account_id, vpn_username, subscription_url, expires_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(account_id) DO UPDATE SET
            vpn_username = excluded.vpn_username,
            subscription_url = excluded.subscription_url,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
        `).run(order.account_id, order.vpn_username, result.subscriptionUrl, result.expiresAt, now);
        db.prepare(`
          UPDATE orders SET status = 'fulfilled', subscription_url = ?, error_code = NULL
          WHERE id = ?
        `).run(result.subscriptionUrl, orderId);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return getOrder(orderId);
    } catch (error) {
      db.prepare(`
        UPDATE orders SET status = 'provisioning_failed', error_code = 'VPN_PROVISIONING_FAILED'
        WHERE id = ?
      `).run(orderId);
      console.error('[vph] VPN provisioning failed', orderId, error.message);
      throw error;
    }
  }

  function markOrderPaid(order, chargeId = null) {
    if (order.status === 'fulfilled' || order.status === 'provisioning') return;
    if (!['pending', 'paid', 'provisioning_failed'].includes(order.status)) {
      throw new Error(`Payment arrived for order in state ${order.status}`);
    }
    db.prepare(`
      UPDATE orders SET status = 'paid', paid_at = COALESCE(paid_at, ?),
        provider_charge_id = COALESCE(provider_charge_id, ?)
      WHERE id = ?
    `).run(Date.now(), chargeId, order.id);
  }

  async function createStarsOrder(request, response) {
    const user = getTelegramUser(request);
    if (!allowCheckout(`tg:${user.id}`)) throw new HttpError(429, 'TOO_MANY_CHECKOUTS');
    if (!isStarsReady(config)) throw new HttpError(503, 'STARS_CHECKOUT_NOT_CONFIGURED');

    const body = parseJson(await readRawBody(request));
    const plan = getPlan(config, body.days);
    if (!plan?.stars) throw new HttpError(400, 'INVALID_PLAN');
    if (body.termsAccepted !== true) throw new HttpError(400, 'TERMS_MUST_BE_ACCEPTED');
    const id = randomUUID();
    const payload = randomUUID();
    const username = `vph_${user.id}`;
    const accountId = `tg:${user.id}`;
    const title = `Vph — ${plan.days} дней`;
    const description = `Доступ к VPN на ${plan.days} дней`;

    db.prepare(`
      INSERT INTO orders (
        id, kind, account_id, telegram_user_id, vpn_username, plan_days,
        amount, currency, invoice_payload, terms_version, terms_accepted_at, status, created_at
      ) VALUES (?, 'stars', ?, ?, ?, ?, ?, 'XTR', ?, ?, ?, 'pending', ?)
    `).run(
      id, accountId, String(user.id), username, plan.days, String(plan.stars), payload,
      config.termsVersion, Date.now(), Date.now()
    );

    try {
      const invoiceUrl = await botApi('createInvoiceLink', {
        title,
        description,
        payload,
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: title, amount: plan.stars }]
      });
      response.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ invoiceUrl }));
    } catch (error) {
      db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(id);
      console.error('[vph] Telegram invoice creation failed', id, error.message);
      throw new HttpError(502, 'INVOICE_CREATION_FAILED');
    }
  }

  async function handleTelegramWebhook(request) {
    if (!config.botToken || !config.telegramWebhookSecret) {
      throw new HttpError(503, 'TELEGRAM_WEBHOOK_NOT_CONFIGURED');
    }
    if (!safeEqual(request.headers['x-telegram-bot-api-secret-token'], config.telegramWebhookSecret)) {
      throw new HttpError(401, 'WEBHOOK_AUTH_INVALID');
    }
    const update = parseJson(await readRawBody(request));
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) {
      throw new HttpError(400, 'INVALID_TELEGRAM_UPDATE');
    }
    if (db.prepare('SELECT 1 FROM telegram_updates WHERE update_id = ?').get(update.update_id)) return;

    if (update.pre_checkout_query) {
      const query = update.pre_checkout_query;
      const order = db.prepare('SELECT * FROM orders WHERE invoice_payload = ?').get(query.invoice_payload);
      const approved = Boolean(
        order &&
        order.kind === 'stars' &&
        order.status === 'pending' &&
        String(query.from?.id) === order.telegram_user_id &&
        query.currency === 'XTR' &&
        String(query.total_amount) === order.amount
      );
      await botApi('answerPreCheckoutQuery', {
        pre_checkout_query_id: query.id,
        ok: approved,
        ...(!approved ? { error_message: 'Счёт недействителен или уже использован. Создай новый.' } : {})
      });
      db.prepare('INSERT INTO telegram_updates (update_id, received_at) VALUES (?, ?)').run(update.update_id, Date.now());
      return;
    }

    const message = update.message;
    const command = typeof message?.text === 'string'
      ? message.text.trim().split(/\s+/, 1)[0].split('@', 1)[0]
      : '';
    if (command === '/start' && message.chat?.id) {
      await botApi('sendMessage', {
        chat_id: message.chat.id,
        text: [
          'Привет! Это Vph — VPN-подписка с управлением через Telegram.',
          '',
          'Открой приложение, чтобы посмотреть статус подписки и доступные тарифы. Оплата и выдача доступа доступны только после настройки сервиса.',
          '',
          'Не пересылай ссылку подписки: она даёт доступ к твоему VPN.',
          '',
          `Поддержка: ${config.supportContact || 'контакт будет опубликован после настройки'}.`
        ].join('\n'),
        ...(config.baseUrl && message.chat.type === 'private' ? {
          reply_markup: {
            inline_keyboard: [[{
              text: 'Открыть Vph',
              web_app: { url: config.baseUrl }
            }]]
          }
        } : {})
      });
      db.prepare('INSERT INTO telegram_updates (update_id, received_at) VALUES (?, ?)')
        .run(update.update_id, Date.now());
      return;
    }
    if (command === '/paysupport' || command === '/support') {
      const contact = config.supportContact || 'Support is not configured yet.';
      await botApi('sendMessage', {
        chat_id: message.chat.id,
        text: `По вопросам оплаты Vph напиши: ${contact}\n\nПоддержка Telegram не может помочь с покупками в этом боте.`
      });
      db.prepare('INSERT INTO telegram_updates (update_id, received_at) VALUES (?, ?)')
        .run(update.update_id, Date.now());
      return;
    }

    const payment = update.message?.successful_payment;
    if (payment) {
      const order = db.prepare('SELECT * FROM orders WHERE invoice_payload = ?').get(payment.invoice_payload);
      if (!order || order.kind !== 'stars' ||
          String(update.message.from?.id) !== order.telegram_user_id ||
          payment.currency !== 'XTR' ||
          String(payment.total_amount) !== order.amount) {
        console.error('[vph] Telegram reported a payment that does not match an order', update.update_id);
        db.prepare('INSERT INTO telegram_updates (update_id, received_at) VALUES (?, ?)').run(update.update_id, Date.now());
        return;
      }
      markOrderPaid(order, payment.telegram_payment_charge_id || null);
      await fulfillOrder(order.id);
    }
    db.prepare('INSERT INTO telegram_updates (update_id, received_at) VALUES (?, ?)').run(update.update_id, Date.now());
  }

  async function createCryptoOrder(request, response) {
    requireCryptoHost(request);
    requireSameOrigin(request);
    if (!allowCheckout(`ip:${request.socket.remoteAddress || 'unknown'}`)) {
      throw new HttpError(429, 'TOO_MANY_CHECKOUTS');
    }
    if (!isCryptoReady(config)) throw new HttpError(503, 'CRYPTO_CHECKOUT_NOT_CONFIGURED');

    const body = parseJson(await readRawBody(request));
    const plan = getPlan(config, body.days);
    if (!plan?.usdt) throw new HttpError(400, 'INVALID_PLAN');
    if (body.termsAccepted !== true) throw new HttpError(400, 'TERMS_MUST_BE_ACCEPTED');

    let customer = getCryptoCustomer(request);
    let newCustomerToken = null;
    if (!customer) {
      newCustomerToken = createSecret();
      const customerId = randomUUID();
      const accountId = `crypto:${customerId}`;
      const vpnUsername = `vph_${customerId.replaceAll('-', '').slice(0, 24)}`;
      db.prepare(`
        INSERT INTO crypto_customers (account_id, vpn_username, session_token_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).run(accountId, vpnUsername, hashSecret(newCustomerToken), Date.now());
      customer = { account_id: accountId, vpn_username: vpnUsername };
    }

    const id = randomUUID();
    const description = `Vph VPN — ${plan.days} days`;
    db.prepare(`
      INSERT INTO orders (
        id, kind, account_id, vpn_username, plan_days, amount, currency,
        invoice_payload, terms_version, terms_accepted_at, status, created_at
      ) VALUES (?, 'crypto', ?, ?, ?, ?, 'USDT', ?, ?, ?, 'pending', ?)
    `).run(
      id, customer.account_id, customer.vpn_username, plan.days, plan.usdt, id,
      config.termsVersion, Date.now(), Date.now()
    );

    try {
      const invoice = await cryptoPay.createInvoice({
        amount: plan.usdt,
        payload: id,
        description
      });
      const checkoutUrl = invoice.web_app_invoice_url || invoice.mini_app_invoice_url || invoice.bot_invoice_url;
      if (!invoice.invoice_id || !checkoutUrl) throw new Error('Crypto Pay invoice response is incomplete');
      db.prepare('UPDATE orders SET provider_invoice_id = ?, checkout_url = ? WHERE id = ?')
        .run(String(invoice.invoice_id), checkoutUrl, id);
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      };
      if (newCustomerToken) {
        const secureCookie = config.cryptoBaseUrl?.startsWith('https:') ? '; Secure' : '';
        headers['Set-Cookie'] = `vph_customer=${newCustomerToken}; HttpOnly; SameSite=Lax; Path=/api/crypto; Max-Age=31536000${secureCookie}`;
      }
      response.writeHead(201, headers);
      response.end(JSON.stringify({ checkoutUrl }));
    } catch (error) {
      db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(id);
      console.error('[vph] Crypto Pay invoice creation failed', id, error.message);
      throw new HttpError(502, 'INVOICE_CREATION_FAILED');
    }
  }

  async function handleCryptoWebhook(request) {
    requireCryptoHost(request);
    if (!config.cryptoPayToken) throw new HttpError(503, 'CRYPTO_WEBHOOK_NOT_CONFIGURED');
    const raw = await readRawBody(request);
    const signature = request.headers['crypto-pay-api-signature'];
    if (!verifyCryptoPaySignature(raw, signature, config.cryptoPayToken)) {
      throw new HttpError(401, 'WEBHOOK_AUTH_INVALID');
    }
    const update = parseJson(raw);
    const invoiceId = update.payload?.invoice_id;
    if (update.update_type === 'invoice_expired' && invoiceId) {
      db.prepare(`
        UPDATE orders SET status = 'expired'
        WHERE provider_invoice_id = ? AND status = 'pending'
      `).run(String(invoiceId));
      return;
    }
    if (update.update_type !== 'invoice_paid' || !invoiceId) return;

    const order = db.prepare('SELECT * FROM orders WHERE provider_invoice_id = ?').get(String(invoiceId));
    if (!order || order.kind !== 'crypto') {
      console.error('[vph] Crypto Pay webhook references an unknown invoice', String(invoiceId));
      return;
    }
    const invoice = await cryptoPay.getInvoice(invoiceId);
    if (!invoice ||
        invoice.status !== 'paid' ||
        invoice.payload !== order.id ||
        (invoice.paid_asset || invoice.asset) !== 'USDT' ||
        !decimalEqual(invoice.paid_amount || invoice.amount, order.amount)) {
      throw new HttpError(400, 'CRYPTO_INVOICE_MISMATCH');
    }
    markOrderPaid(order, String(invoiceId));
    await fulfillOrder(order.id);
  }

  function telegramSubscription(request) {
    const user = getTelegramUser(request);
    const accountId = `tg:${user.id}`;
    const account = db.prepare('SELECT * FROM accounts WHERE account_id = ?').get(accountId);
    if (account && account.expires_at > Date.now()) {
      return {
        status: 'active',
        expiresAt: account.expires_at,
        subscriptionUrl: account.subscription_url
      };
    }
    const failed = db.prepare(`
      SELECT id FROM orders WHERE account_id = ? AND status = 'provisioning_failed'
      ORDER BY created_at DESC LIMIT 1
    `).get(accountId);
    if (failed) return { status: 'provisioning_failed', expiresAt: account?.expires_at || null };
    const pendingProvision = db.prepare(`
      SELECT id FROM orders WHERE account_id = ? AND status IN ('paid', 'provisioning')
      ORDER BY created_at DESC LIMIT 1
    `).get(accountId);
    if (pendingProvision) return { status: 'provisioning', expiresAt: account?.expires_at || null };
    return {
      status: account ? 'expired' : 'inactive',
      expiresAt: account?.expires_at || null,
      subscriptionUrl: null
    };
  }

  async function handleRequest(request, response) {
    const url = new URL(request.url, config.baseUrl || 'http://localhost');
    const pathname = url.pathname;
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', contentSecurityPolicy());

    try {
      if (request.method === 'GET' && pathname === '/api/health') {
        return sendJson(response, 200, {
          ok: true,
          starsReady: isStarsReady(config),
          cryptoReady: isCryptoReady(config),
          vpnReady: config.marzban.configured
        });
      }
      if (request.method === 'GET' && pathname === '/api/plans') {
        return sendJson(response, 200, {
          starsReady: isStarsReady(config),
          plans: config.plans.map(({ days, stars }) => ({ days, stars }))
        });
      }
      if (request.method === 'GET' && pathname === '/api/terms') {
        return sendJson(response, 200, {
          available: Boolean(config.termsUrl && config.termsVersion),
          url: config.termsUrl,
          version: config.termsVersion,
          operatorName: config.operatorName,
          operatorEmail: config.operatorEmail,
          supportContact: config.supportContact
        });
      }
      if (request.method === 'GET' && pathname === '/api/crypto/plans') {
        requireCryptoHost(request);
        return sendJson(response, 200, {
          cryptoReady: isCryptoReady(config),
          plans: config.plans.map(({ days, usdt }) => ({ days, asset: 'USDT', amount: usdt }))
        });
      }
      if (request.method === 'GET' && pathname === '/api/crypto/order') {
        requireCryptoHost(request);
        const customer = getCryptoCustomer(request);
        if (!customer) return sendJson(response, 200, { status: 'none' });
        const order = db.prepare(`
          SELECT * FROM orders WHERE account_id = ? AND kind = 'crypto'
          ORDER BY created_at DESC, rowid DESC LIMIT 1
        `).get(customer.account_id);
        if (!order) return sendJson(response, 200, { status: 'none' });
        const account = db.prepare('SELECT * FROM accounts WHERE account_id = ?')
          .get(customer.account_id);
        return sendJson(response, 200, {
          status: order.status,
          expiresAt: account?.expires_at || order.target_expires_at,
          subscriptionUrl: account?.expires_at > Date.now() ? account.subscription_url : null
        });
      }
      if (request.method === 'GET' && pathname === '/api/me') {
        return sendJson(response, 200, telegramSubscription(request));
      }
      if (request.method === 'POST' && pathname === '/api/telegram/orders') {
        return await createStarsOrder(request, response);
      }
      if (request.method === 'POST' && pathname === '/api/subscription/retry') {
        const user = getTelegramUser(request);
        const order = db.prepare(`
          SELECT id FROM orders
          WHERE account_id = ? AND status = 'provisioning_failed'
          ORDER BY created_at DESC LIMIT 1
        `).get(`tg:${user.id}`);
        if (!order) throw new HttpError(404, 'NO_RETRYABLE_ORDER');
        await fulfillOrder(order.id);
        return sendJson(response, 200, telegramSubscription(request));
      }
      if (request.method === 'POST' && pathname === '/api/crypto/orders') {
        return await createCryptoOrder(request, response);
      }
      if (request.method === 'POST' && pathname === '/api/crypto/order/retry') {
        requireCryptoHost(request);
        requireSameOrigin(request);
        const customer = getCryptoCustomer(request);
        if (!customer) throw new HttpError(401, 'CHECKOUT_SESSION_REQUIRED');
        const order = db.prepare(`
          SELECT id FROM orders
          WHERE account_id = ? AND kind = 'crypto' AND status = 'provisioning_failed'
          ORDER BY created_at DESC, rowid DESC LIMIT 1
        `).get(customer.account_id);
        if (!order) throw new HttpError(404, 'NO_RETRYABLE_ORDER');
        const fulfilled = await fulfillOrder(order.id);
        return sendJson(response, 200, {
          status: fulfilled.status,
          expiresAt: fulfilled.target_expires_at,
          subscriptionUrl: fulfilled.subscription_url
        });
      }
      if (request.method === 'POST' && /^\/webhooks\/(telegram|crypto)$/.test(pathname)) {
        if (pathname.endsWith('/telegram')) await handleTelegramWebhook(request);
        else await handleCryptoWebhook(request);
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return response.end('ok');
      }
      if (request.method === 'GET') {
        const staticFiles = new Map([
          ['/', 'index.html'],
          ['/index.html', 'index.html'],
          ['/app.js', 'app.js'],
          ['/terms.html', 'terms.html'],
          ['/terms.js', 'terms.js'],
        ]);
        if (request.headers.host?.toLowerCase() ===
            (config.cryptoBaseUrl && new URL(config.cryptoBaseUrl).host.toLowerCase())) {
          staticFiles.set('/crypto.html', 'crypto.html');
          staticFiles.set('/crypto.js', 'crypto.js');
        }
        const fileName = staticFiles.get(pathname);
        if (fileName) {
          const filePath = resolve(ROOT, fileName);
          const content = await readFile(filePath);
          response.writeHead(200, {
            'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
          });
          return response.end(content);
        }
      }
      return sendJson(response, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
      if (status >= 500) console.error('[vph] request failed', request.method, pathname, error.message);
      if (!response.headersSent) sendJson(response, status, { error: code });
      else response.destroy();
    }
  }

  return {
    server: createHttpServer((request, response) => {
      handleRequest(request, response).catch((error) => {
        console.error('[vph] unhandled request failure', error.message);
        if (!response.headersSent) sendJson(response, 500, { error: 'INTERNAL_ERROR' });
        else response.destroy();
      });
    }),
    db
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('PORT must be a valid TCP port');
  }
  mkdirSync(dirname(resolve(config.databasePath)), { recursive: true });
  const { server, db } = createVphServer({ config });
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`[vph] listening on port ${config.port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => {
      db.close();
      process.exit(0);
    }));
  }
}
