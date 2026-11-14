const crypto = require('node:crypto');

const secret = process.env.AGENT_GRANT_SECRET || 'dev-grant-secret';

function signGrant(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyGrant(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;

  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length) return null;
  if (!crypto.timingSafeEqual(given, wanted)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload.exp || Number(payload.exp) < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

module.exports = { signGrant, verifyGrant };
