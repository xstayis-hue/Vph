import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';

import { loadConfig, isCryptoReady, isStarsReady } from '../src/config.mjs';
import {
  hashSecret,
  validateTelegramInitData,
  verifyCryptoPaySignature
} from '../src/security.mjs';

function signedInitData(user, token, authDate = Math.floor(Date.now() / 1000)) {
  const values = new URLSearchParams({
    auth_date: String(authDate),
    user: JSON.stringify(user),
    query_id: 'test-query'
  });
  const data = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  values.set('hash', createHmac('sha256', secret).update(data).digest('hex'));
  return values.toString();
}

function configuredEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    BASE_URL: 'https://vph.example.com',
    CRYPTO_BASE_URL: 'https://pay.example.com',
    BOT_TOKEN: 'bot-token',
    TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(32),
    VPH_SUPPORT_CONTACT: '@vph_support',
    VPH_OPERATOR_NAME: 'Vph Test',
    VPH_OPERATOR_EMAIL: 'support@vph.example.com',
    VPH_TERMS_URL: 'https://vph.example.com/terms',
    VPH_TERMS_VERSION: '2025-01',
    CRYPTO_PAY_TOKEN: 'crypto-token',
    MARZBAN_URL: 'https://panel.example.com',
    MARZBAN_USERNAME: 'admin',
    MARZBAN_PASSWORD: 'password',
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

test('validates signed Telegram Mini App data and rejects tampering', () => {
  const token = 'bot-token';
  const initData = signedInitData({ id: 123456, username: 'tester' }, token);

  assert.equal(validateTelegramInitData(initData, token).id, 123456);
  assert.throws(
    () => validateTelegramInitData(`${initData}&auth_date=1`, token),
    /duplicate fields/
  );
  assert.throws(
    () => validateTelegramInitData(initData.replace('tester', 'attacker'), token),
    /signature/
  );
});

test('rejects expired and future-dated Telegram data', () => {
  const token = 'bot-token';
  const now = Date.now();
  assert.throws(
    () => validateTelegramInitData(signedInitData({ id: 5 }, token, Math.floor(now / 1000) - 86401), token, now),
    /expired/
  );
  assert.throws(
    () => validateTelegramInitData(signedInitData({ id: 5 }, token, Math.floor(now / 1000) + 60), token, now),
    /date/
  );
});

test('verifies Crypto Pay signatures over the exact raw request body', () => {
  const token = 'crypto-token';
  const body = Buffer.from('{"update_type":"invoice_paid"}');
  const key = createHash('sha256').update(token).digest();
  const signature = createHmac('sha256', key).update(body).digest('hex');

  assert.equal(verifyCryptoPaySignature(body, signature, token), true);
  assert.equal(verifyCryptoPaySignature(Buffer.from(`${body} `), signature, token), false);
  assert.equal(verifyCryptoPaySignature(body, signature, 'wrong-token'), false);
});

test('checkout readiness requires server, provider, webhook, and all configured prices', () => {
  const ready = loadConfig(configuredEnv());
  assert.equal(isStarsReady(ready), true);
  assert.equal(isCryptoReady(ready), true);

  const missing = loadConfig(configuredEnv({ VPH_STARS_90: '', CRYPTO_PAY_TOKEN: '' }));
  assert.equal(isStarsReady(missing), false);
  assert.equal(isCryptoReady(missing), false);
  const noPanel = loadConfig(configuredEnv({ MARZBAN_URL: '' }));
  assert.equal(isStarsReady(noPanel), false);
  assert.equal(isCryptoReady(noPanel), false);
  const defaultTerms = loadConfig(configuredEnv({ VPH_TERMS_URL: '', VPH_TERMS_VERSION: '' }));
  assert.equal(defaultTerms.termsUrl, 'https://vph.example.com/terms.html');
  assert.equal(defaultTerms.termsVersion, '2026-10-03-v1');
  assert.equal(isStarsReady(defaultTerms), true);
  assert.equal(isCryptoReady(defaultTerms), true);
  const noOperator = loadConfig(configuredEnv({ VPH_OPERATOR_NAME: '', VPH_OPERATOR_EMAIL: '' }));
  assert.equal(isStarsReady(noOperator), false);
  assert.equal(isCryptoReady(noOperator), false);
  const noSupport = loadConfig(configuredEnv({ VPH_SUPPORT_CONTACT: '' }));
  assert.equal(isStarsReady(noSupport), false);
  assert.equal(isCryptoReady(noSupport), false);

  const insecure = loadConfig(configuredEnv({
    NODE_ENV: 'development',
    BASE_URL: 'http://vph.example.com',
    CRYPTO_BASE_URL: 'http://pay.example.com',
    MARZBAN_URL: 'http://panel.example.com'
  }));
  assert.equal(isStarsReady(insecure), false);
  assert.equal(isCryptoReady(insecure), false);
});

test('rejects invalid configured prices instead of silently accepting them', () => {
  assert.throws(
    () => loadConfig(configuredEnv({ VPH_STARS_30: '-100' })),
    /positive safe integer/
  );
  assert.throws(
    () => loadConfig(configuredEnv({ VPH_USDT_30: '0' })),
    /positive decimal/
  );
});

test('hashes checkout bearer secrets before persistence', () => {
  assert.equal(hashSecret('secret').length, 64);
  assert.notEqual(hashSecret('secret'), 'secret');
});
