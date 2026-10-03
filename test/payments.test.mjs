import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import test from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { createDatabase } from '../src/database.mjs';
import { createVphServer } from '../server.mjs';

const BOT_TOKEN = 'bot-token';
const CRYPTO_TOKEN = 'crypto-token';
const WEBHOOK_SECRET = 'telegram-webhook-secret-32-characters';

function env(overrides = {}) {
  return {
    NODE_ENV: 'production',
    BASE_URL: 'https://vph.example.test',
    CRYPTO_BASE_URL: 'https://pay.vph.example.test',
    BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    VPH_SUPPORT_CONTACT: '@vph_support',
    VPH_OPERATOR_NAME: 'Vph Test',
    VPH_OPERATOR_EMAIL: 'support@vph.example.test',
    VPH_TERMS_URL: 'https://vph.example.test/terms.html',
    VPH_TERMS_VERSION: '2025-01',
    CRYPTO_PAY_TOKEN: CRYPTO_TOKEN,
    MARZBAN_URL: 'https://panel.example.test',
    MARZBAN_USERNAME: 'admin',
    MARZBAN_PASSWORD: 'secret',
    VPH_INBOUND_TAG: 'VLESS REALITY',
    VPH_STARS_30: '100',
    VPH_STARS_90: '250',
    VPH_STARS_180: '450',
    VPH_USDT_30: '3',
    VPH_USDT_90: '7.5',
    VPH_USDT_180: '12',
    ...overrides
  };
}

function initData(userId) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, username: 'test-user' })
  });
  const data = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(data).digest('hex'));
  return params.toString();
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function buildUpstreamFetch({ cryptoInvoiceId = '998877' } = {}) {
  const marzbanUsers = new Map();
  const cryptoInvoices = new Map();
  let nextCryptoInvoiceId = Number(cryptoInvoiceId);

  const sentMessages = [];
  const upstreamFetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'api.telegram.org') {
      const method = url.pathname.split('/').pop();
      if (method === 'createInvoiceLink') return jsonResponse({ ok: true, result: 'https://t.me/$test-invoice' });
      if (method === 'answerPreCheckoutQuery') return jsonResponse({ ok: true, result: true });
      if (method === 'sendMessage') {
        sentMessages.push(JSON.parse(options.body));
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      }
      throw new Error(`Unexpected Telegram method: ${method}`);
    }
    if (url.hostname === 'panel.example.test') {
      if (url.pathname === '/api/admin/token') {
        return jsonResponse({ access_token: 'marzban-access-token', expires_in: 3600 });
      }
      const userPath = decodeURIComponent(url.pathname.replace('/api/user/', ''));
      if (url.pathname === '/api/user' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        marzbanUsers.set(body.username, body);
        return jsonResponse({
          username: body.username,
          expire: body.expire,
          subscription_url: `https://panel.example.test/sub/${body.username}`
        });
      }
      if (url.pathname.startsWith('/api/user/')) {
        const user = marzbanUsers.get(userPath);
        if (!user) return jsonResponse({ detail: 'Not found' }, 404);
        if (options.method === 'PUT') {
          const update = JSON.parse(options.body);
          Object.assign(user, update);
        }
        return jsonResponse({
          username: userPath,
          expire: user.expire,
          subscription_url: `https://panel.example.test/sub/${userPath}`
        });
      }
      throw new Error(`Unexpected Marzban request: ${options.method} ${url.pathname}`);
    }
    if (url.hostname === 'pay.crypt.bot') {
      const method = url.pathname.split('/').pop();
      if (method === 'createInvoice') {
        const body = JSON.parse(options.body);
        const invoiceId = nextCryptoInvoiceId++;
        cryptoInvoices.set(String(invoiceId), {
          invoice_id: invoiceId,
          status: 'paid',
          payload: body.payload,
          paid_asset: 'USDT',
          paid_amount: body.amount
        });
        return jsonResponse({
          ok: true,
          result: {
            invoice_id: invoiceId,
            web_app_invoice_url: 'https://t.me/CryptoBot?start=invoice'
          }
        });
      }
      if (method === 'getInvoices') {
        const invoice = cryptoInvoices.get(url.searchParams.get('invoice_ids'));
        return jsonResponse({
          ok: true,
          result: {
            items: invoice ? [invoice] : []
          }
        });
      }
      throw new Error(`Unexpected Crypto Pay method: ${method}`);
    }
    throw new Error(`Unexpected upstream host: ${url.hostname}`);
  };
  upstreamFetch.sentMessages = sentMessages;
  return upstreamFetch;
}

async function startServer({ config = loadConfig(env()), upstreamFetch } = {}) {
  const db = createDatabase(':memory:');
  const app = createVphServer({ config, db, fetchImpl: upstreamFetch });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    db,
    server: app.server,
    config,
    base,
    cryptoHost: new URL(config.cryptoBaseUrl).host,
    cryptoOrigin: new URL(config.cryptoBaseUrl).origin,
    close: async () => {
      await new Promise((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
      db.close();
    }
  };
}

function fetchWithHost(url, host, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: options.method || 'GET',
      headers: { ...options.headers, host }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          headers: {
            get(name) {
              const value = response.headers[name.toLowerCase()];
              return Array.isArray(value) ? value[0] : value || null;
            }
          },
          async json() {
            return JSON.parse(body);
          }
        });
      });
    });
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

test('Telegram Stars order is only fulfilled after a matching successful payment update', async (t) => {
  const app = await startServer({ upstreamFetch: buildUpstreamFetch() });
  t.after(app.close);
  const headers = {
    Authorization: `tma ${initData(123456)}`,
    'Content-Type': 'application/json'
  };

  const missingConsent = await fetch(`${app.base}/api/telegram/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ days: 30, termsAccepted: false })
  });
  assert.equal(missingConsent.status, 400);

  const checkout = await fetch(`${app.base}/api/telegram/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ days: 30, termsAccepted: true })
  });
  assert.equal(checkout.status, 201);
  assert.equal((await checkout.json()).invoiceUrl, 'https://t.me/$test-invoice');
  const order = app.db.prepare('SELECT * FROM orders').get();
  assert.equal(order.status, 'pending');
  assert.equal(order.currency, 'XTR');
  assert.equal(order.terms_version, '2025-01');
  assert.ok(order.terms_accepted_at > 0);

  const preCheckout = await fetch(`${app.base}/webhooks/telegram`, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      update_id: 100,
      pre_checkout_query: {
        id: 'pre-checkout-1',
        from: { id: 123456 },
        invoice_payload: order.invoice_payload,
        currency: 'XTR',
        total_amount: 100
      }
    })
  });
  assert.equal(preCheckout.status, 200);

  const mismatchedPayment = await fetch(`${app.base}/webhooks/telegram`, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      update_id: 102,
      message: {
        from: { id: 123456 },
        successful_payment: {
          invoice_payload: order.invoice_payload,
          currency: 'XTR',
          total_amount: 999,
          telegram_payment_charge_id: 'wrong-charge'
        }
      }
    })
  });
  assert.equal(mismatchedPayment.status, 200);
  assert.equal(app.db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'pending');

  const paid = await fetch(`${app.base}/webhooks/telegram`, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      update_id: 101,
      message: {
        from: { id: 123456 },
        successful_payment: {
          invoice_payload: order.invoice_payload,
          currency: 'XTR',
          total_amount: 100,
          telegram_payment_charge_id: 'charge-1'
        }
      }
    })
  });
  assert.equal(paid.status, 200);
  assert.equal(app.db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'fulfilled');
  const duplicate = await fetch(`${app.base}/webhooks/telegram`, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      update_id: 101,
      message: {
        from: { id: 123456 },
        successful_payment: {
          invoice_payload: order.invoice_payload,
          currency: 'XTR',
          total_amount: 100,
          telegram_payment_charge_id: 'charge-1'
        }
      }
    })
  });
  assert.equal(duplicate.status, 200);

  const subscription = await fetch(`${app.base}/api/me`, { headers });
  assert.deepEqual(await subscription.json(), {
    status: 'active',
    expiresAt: app.db.prepare('SELECT expires_at FROM accounts WHERE account_id = ?').get('tg:123456').expires_at,
    subscriptionUrl: 'https://panel.example.test/sub/vph_123456'
  });
});

test('Telegram /paysupport replies with the configured merchant contact', async (t) => {
  const upstreamFetch = buildUpstreamFetch();
  const app = await startServer({ upstreamFetch });
  t.after(app.close);
  const response = await fetch(`${app.base}/webhooks/telegram`, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      update_id: 150,
      message: {
        chat: { id: 123456 },
        text: '/paysupport@vph_test_bot',
        from: { id: 123456 }
      }
    })
  });

  assert.equal(response.status, 200);
  assert.match(upstreamFetch.sentMessages[0].text, /@vph_support/);
  assert.match(upstreamFetch.sentMessages[0].text, /не может помочь/);
});

test('Telegram /start greets the user and offers the Mini App', async (t) => {
  const upstreamFetch = buildUpstreamFetch();
  const app = await startServer({ upstreamFetch });
  t.after(app.close);
  const response = await fetch(`${app.base}/webhooks/telegram`, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      update_id: 151,
      message: {
        chat: { id: 123456, type: 'private' },
        text: '/start',
        from: { id: 123456 }
      }
    })
  });
  assert.equal(response.status, 200);
  assert.match(upstreamFetch.sentMessages[0].text, /Привет! Это Vph/);
  assert.equal(
    upstreamFetch.sentMessages[0].reply_markup.inline_keyboard[0][0].web_app.url,
    'https://vph.example.test'
  );
});

test('external Crypto Pay invoice is verified before Marzban access is returned', async (t) => {
  const app = await startServer({ upstreamFetch: buildUpstreamFetch() });
  t.after(app.close);
  const checkout = await fetchWithHost(`${app.base}/api/crypto/orders`, app.cryptoHost, {
    method: 'POST',
    headers: { Origin: app.cryptoOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: 30, termsAccepted: true })
  });
  assert.equal(checkout.status, 201);
  const checkoutBody = await checkout.json();
  assert.equal(checkoutBody.checkoutUrl, 'https://t.me/CryptoBot?start=invoice');
  assert.doesNotMatch(JSON.stringify(checkoutBody), /accessToken|statusUrl/);
  assert.match(checkout.headers.get('set-cookie'), /vph_customer=.*HttpOnly/);
  const cookie = checkout.headers.get('set-cookie').split(';')[0];
  const order = app.db.prepare('SELECT * FROM orders').get();
  assert.equal(order.status, 'pending');
  assert.equal(order.currency, 'USDT');
  assert.equal(order.terms_version, '2025-01');
  assert.ok(order.terms_accepted_at > 0);

  const webhookBody = Buffer.from(JSON.stringify({
    update_type: 'invoice_paid',
    payload: { invoice_id: 998877 }
  }));
  const key = createHash('sha256').update(CRYPTO_TOKEN).digest();
  const signature = createHmac('sha256', key).update(webhookBody).digest('hex');
  const webhook = await fetchWithHost(`${app.base}/webhooks/crypto`, app.cryptoHost, {
    method: 'POST',
    headers: {
      'crypto-pay-api-signature': signature,
      'Content-Type': 'application/json'
    },
    body: webhookBody
  });
  assert.equal(webhook.status, 200);
  assert.equal(app.db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'fulfilled');

  const status = await fetchWithHost(`${app.base}/api/crypto/order`, app.cryptoHost, {
    headers: { Cookie: cookie }
  });
  assert.deepEqual(await status.json(), {
    status: 'fulfilled',
    expiresAt: app.db.prepare('SELECT expires_at FROM accounts WHERE account_id = ?').get(order.account_id).expires_at,
    subscriptionUrl: `https://panel.example.test/sub/${order.vpn_username}`
  });

  const previousExpiry = app.db.prepare('SELECT expires_at FROM accounts WHERE account_id = ?')
    .get(order.account_id).expires_at;
  const renewal = await fetchWithHost(`${app.base}/api/crypto/orders`, app.cryptoHost, {
    method: 'POST',
    headers: { Origin: app.cryptoOrigin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: 30, termsAccepted: true })
  });
  assert.equal(renewal.status, 201);
  const renewalOrder = app.db.prepare('SELECT * FROM orders WHERE id != ?').get(order.id);
  assert.equal(renewalOrder.account_id, order.account_id);
  assert.equal(renewalOrder.vpn_username, order.vpn_username);

  const renewalPayload = Buffer.from(JSON.stringify({
    update_type: 'invoice_paid',
    payload: { invoice_id: 998878 }
  }));
  const renewalSignature = createHmac(
    'sha256',
    createHash('sha256').update(CRYPTO_TOKEN).digest()
  ).update(renewalPayload).digest('hex');
  const renewalWebhook = await fetchWithHost(`${app.base}/webhooks/crypto`, app.cryptoHost, {
    method: 'POST',
    headers: { 'crypto-pay-api-signature': renewalSignature, 'Content-Type': 'application/json' },
    body: renewalPayload
  });
  assert.equal(renewalWebhook.status, 200);
  const renewedExpiry = app.db.prepare('SELECT expires_at FROM accounts WHERE account_id = ?')
    .get(order.account_id).expires_at;
  assert.ok(renewedExpiry > previousExpiry + 29 * 86400000);
});

test('simultaneous paid renewals for one Telegram account are serialized', async (t) => {
  const app = await startServer({ upstreamFetch: buildUpstreamFetch() });
  t.after(app.close);
  const headers = {
    Authorization: `tma ${initData(654321)}`,
    'Content-Type': 'application/json'
  };

  for (let index = 0; index < 2; index += 1) {
    const checkout = await fetch(`${app.base}/api/telegram/orders`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ days: 30, termsAccepted: true })
    });
    assert.equal(checkout.status, 201);
  }
  const orders = app.db.prepare('SELECT * FROM orders ORDER BY created_at, rowid').all();
  assert.equal(orders.length, 2);

  const updates = await Promise.all(orders.map((order, index) => fetch(`${app.base}/webhooks/telegram`, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      update_id: 300 + index,
      message: {
        from: { id: 654321 },
        successful_payment: {
          invoice_payload: order.invoice_payload,
          currency: 'XTR',
          total_amount: 100,
          telegram_payment_charge_id: `charge-${index}`
        }
      }
    })
  })));
  assert.deepEqual(updates.map((response) => response.status), [200, 200]);

  const account = app.db.prepare('SELECT expires_at FROM accounts WHERE account_id = ?').get('tg:654321');
  assert.ok(account.expires_at > Date.now() + 59 * 86400000);
  assert.deepEqual(
    app.db.prepare('SELECT status FROM orders ORDER BY created_at, rowid').all().map((order) => order.status),
    ['fulfilled', 'fulfilled']
  );
});

test('checkout is rejected when the Telegram identity or external origin is invalid', async (t) => {
  const app = await startServer({ upstreamFetch: buildUpstreamFetch() });
  t.after(app.close);
  const invalidIdentity = await fetch(`${app.base}/api/telegram/orders`, {
    method: 'POST',
    headers: { Authorization: 'tma invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: 30 })
  });
  assert.equal(invalidIdentity.status, 401);

  const invalidOrigin = await fetchWithHost(`${app.base}/api/crypto/orders`, app.cryptoHost, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: 30 })
  });
  assert.equal(invalidOrigin.status, 403);

  const cryptoWithoutConsent = await fetchWithHost(`${app.base}/api/crypto/orders`, app.cryptoHost, {
    method: 'POST',
    headers: { Origin: app.cryptoOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: 30, termsAccepted: false })
  });
  assert.equal(cryptoWithoutConsent.status, 400);
});

test('external checkout is separated while shared terms stay public', async (t) => {
  const app = await startServer({ upstreamFetch: buildUpstreamFetch() });
  t.after(app.close);
  const checkoutPage = await fetch(`${app.base}/crypto.html`);
  const cryptoApi = await fetch(`${app.base}/api/crypto/plans`);
  assert.equal(checkoutPage.status, 404);
  assert.equal(cryptoApi.status, 404);
  const termsPage = await fetch(`${app.base}/terms.html`);
  assert.equal(termsPage.status, 200);
  assert.match(await termsPage.text(), /Условия использования сервиса/);
  const terms = await fetch(`${app.base}/api/terms`);
  assert.deepEqual(await terms.json(), {
    available: true,
    url: 'https://vph.example.test/terms.html',
    version: '2025-01',
    operatorName: 'Vph Test',
    operatorEmail: 'support@vph.example.test',
    supportContact: '@vph_support'
  });
});

test('payment methods remain disabled until every required integration is configured', async (t) => {
  const config = loadConfig(env({
    BOT_TOKEN: '',
    TELEGRAM_WEBHOOK_SECRET: '',
    CRYPTO_PAY_TOKEN: '',
    MARZBAN_PASSWORD: '',
    VPH_STARS_30: '',
    VPH_USDT_30: ''
  }));
  const app = await startServer({ config, upstreamFetch: buildUpstreamFetch() });
  t.after(app.close);

  const health = await fetch(`${app.base}/api/health`);
  assert.deepEqual(await health.json(), {
    ok: true,
    starsReady: false,
    cryptoReady: false,
    vpnReady: false
  });
  const checkout = await fetchWithHost(`${app.base}/api/crypto/orders`, app.cryptoHost, {
    method: 'POST',
    headers: { Origin: app.cryptoOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: 30 })
  });
  assert.equal(checkout.status, 503);
});
