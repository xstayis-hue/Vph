import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
export function validateTelegramInitData(initData, botToken, now = Date.now()) {
  if (typeof initData !== 'string' || !initData || initData.length > 8192) {
    throw new Error('Telegram init data is missing or invalid');
  }

  const params = new URLSearchParams(initData);
  const entries = [...params.entries()];
  const values = new Map(entries);
  if (entries.length !== values.size) {
    throw new Error('Telegram init data contains duplicate fields');
  }

  const suppliedHash = values.get('hash');
  const authDate = Number(values.get('auth_date'));
  const userJson = values.get('user');
  if (!suppliedHash || !/^[a-f0-9]{64}$/i.test(suppliedHash) || !userJson) {
    throw new Error('Telegram init data is incomplete');
  }
  if (!Number.isSafeInteger(authDate) || authDate <= 0 || authDate > Math.floor(now / 1000) + 30) {
    throw new Error('Telegram init data has an invalid authentication date');
  }
  if (Math.floor(now / 1000) - authDate > 86400) {
    throw new Error('Telegram init data has expired');
  }

  values.delete('hash');
  const dataCheckString = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (!constantTimeEqual(expectedHash, suppliedHash.toLowerCase())) {
    throw new Error('Telegram init data signature is invalid');
  }

  let user;
  try {
    user = JSON.parse(userJson);
  } catch {
    throw new Error('Telegram user data is invalid JSON');
  }
  if (!Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new Error('Telegram user ID is invalid');
  }
  return user;
}

export function verifyCryptoPaySignature(rawBody, suppliedSignature, apiToken) {
  if (!Buffer.isBuffer(rawBody) || typeof suppliedSignature !== 'string' || !apiToken) {
    return false;
  }
  const secret = createHash('sha256').update(apiToken).digest();
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return /^[a-f0-9]{64}$/i.test(suppliedSignature) &&
    constantTimeEqual(expected, suppliedSignature.toLowerCase());
}

export function hashSecret(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function createSecret() {
  return randomBytes(32).toString('base64url');
}
