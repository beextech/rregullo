// Small Web Crypto helpers. They run unchanged in Cloudflare Workers and in Node 20+.

const enc = new TextEncoder();

export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** 32 random bytes, URL-safe: the confirmation token that goes in the email. */
export function randomToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

/** HMAC-SHA256 with a purpose label, so one APP_SECRET yields independent keys. */
export async function hmac(secret, purpose, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`${purpose}:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

/** Constant-time comparison for equal-length hex strings. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const emailHash = (secret, email) => hmac(secret, 'email', email);
export const unsubscribeSig = (secret, id) => hmac(secret, 'unsubscribe', id);
export const ipBucket = (secret, ip, now) => hmac(secret, 'ip', `${ip}|${Math.floor(now / 86400000)}`);

export function uuid() {
  return crypto.randomUUID();
}
