const PLAN_DAYS = [30, 90, 180];
const VALID_PROTOCOLS = new Set(['vless', 'vmess', 'trojan', 'shadowsocks']);

function optionalString(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed || null;
}

function optionalPositiveInteger(value, name) {
  const raw = optionalString(value);
  if (!raw) return null;

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function optionalDecimal(value, name) {
  const raw = optionalString(value);
  if (!raw) return null;
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,8})?$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`${name} must be a positive decimal with at most 8 fractional digits`);
  }
  return raw;
}

function optionalHttpUrl(value, name, allowHttp) {
  const raw = optionalString(value);
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new Error(`${name} must use HTTPS`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, query parameters, or a fragment`);
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function loadConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  const protocol = optionalString(env.VPH_PROTOCOL) || 'vless';
  if (!VALID_PROTOCOLS.has(protocol)) {
    throw new Error(`VPH_PROTOCOL must be one of: ${[...VALID_PROTOCOLS].join(', ')}`);
  }

  const baseUrl = optionalHttpUrl(env.BASE_URL, 'BASE_URL', !isProduction);
  const cryptoBaseUrl = optionalHttpUrl(env.CRYPTO_BASE_URL, 'CRYPTO_BASE_URL', !isProduction);
  const cryptoPayToken = optionalString(env.CRYPTO_PAY_TOKEN);
  const marzbanUrl = optionalHttpUrl(env.MARZBAN_URL, 'MARZBAN_URL', !isProduction);
  const marzbanUsername = optionalString(env.MARZBAN_USERNAME);
  const marzbanPassword = optionalString(env.MARZBAN_PASSWORD);
  const marzbanInbound = optionalString(env.VPH_INBOUND_TAG);
  const termsUrl = optionalHttpUrl(
    env.VPH_TERMS_URL || (baseUrl ? `${baseUrl}/terms.html` : null),
    'VPH_TERMS_URL',
    !isProduction
  );
  const termsVersion = optionalString(env.VPH_TERMS_VERSION) || '2026-10-03-v1';
  const operatorName = optionalString(env.VPH_OPERATOR_NAME);
  const operatorEmail = optionalString(env.VPH_OPERATOR_EMAIL);
  if (termsVersion && termsVersion.length > 64) {
    throw new Error('VPH_TERMS_VERSION must be at most 64 characters');
  }
  if (operatorEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(operatorEmail)) {
    throw new Error('VPH_OPERATOR_EMAIL must be a valid email address');
  }
  const marzbanConfigured = Boolean(
    marzbanUrl && marzbanUsername && marzbanPassword && marzbanInbound
  );
  const plans = PLAN_DAYS.map((days) => ({
    days,
    stars: optionalPositiveInteger(env[`VPH_STARS_${days}`], `VPH_STARS_${days}`),
    usdt: optionalDecimal(env[`VPH_USDT_${days}`], `VPH_USDT_${days}`)
  }));

  return {
    port: Number(env.PORT || 3000),
    databasePath: optionalString(env.DATABASE_PATH) || './data/vph.sqlite',
    baseUrl,
    cryptoBaseUrl,
    botToken: optionalString(env.BOT_TOKEN),
    telegramWebhookSecret: optionalString(env.TELEGRAM_WEBHOOK_SECRET),
    supportContact: optionalString(env.VPH_SUPPORT_CONTACT),
    operatorName,
    operatorEmail,
    termsUrl,
    termsVersion,
    cryptoPayToken,
    cryptoPayBaseUrl: env.CRYPTO_PAY_TESTNET === 'true'
      ? 'https://testnet-pay.crypt.bot/api'
      : 'https://pay.crypt.bot/api',
    marzban: {
      url: marzbanUrl,
      username: marzbanUsername,
      password: marzbanPassword,
      protocol,
      inbound: marzbanInbound,
      configured: marzbanConfigured
    },
    plans,
    starsConfigured: plans.every((plan) => plan.stars !== null),
    cryptoConfigured: plans.every((plan) => plan.usdt !== null)
  };
}

export function getPlan(config, days) {
  return config.plans.find((plan) => plan.days === Number(days)) || null;
}

export function isStarsReady(config) {
  return Boolean(
    config.baseUrl &&
    new URL(config.baseUrl).protocol === 'https:' &&
    config.marzban.configured &&
    config.marzban.url &&
    new URL(config.marzban.url).protocol === 'https:' &&
    config.botToken &&
    config.telegramWebhookSecret &&
    config.supportContact &&
    config.operatorName &&
    config.operatorEmail &&
    config.termsUrl &&
    new URL(config.termsUrl).protocol === 'https:' &&
    config.termsVersion &&
    config.starsConfigured
  );
}

export function isCryptoReady(config) {
  return Boolean(
    config.cryptoBaseUrl &&
    config.baseUrl &&
    config.marzban.configured &&
    config.marzban.url &&
    new URL(config.cryptoBaseUrl).protocol === 'https:' &&
    new URL(config.baseUrl).protocol === 'https:' &&
    new URL(config.marzban.url).protocol === 'https:' &&
    new URL(config.cryptoBaseUrl).host !== new URL(config.baseUrl).host &&
    config.cryptoPayToken &&
    config.supportContact &&
    config.operatorName &&
    config.operatorEmail &&
    config.termsUrl &&
    new URL(config.termsUrl).protocol === 'https:' &&
    config.termsVersion &&
    config.cryptoConfigured
  );
}
