// Mjeshtër sign-in by SMS code, and the sessions that keep them signed in.
// Every query is a prepared statement with bound parameters. Logs carry event names only: no numbers, no codes.

import { hmac, randomToken, safeEqual, sha256, uuid } from './crypto.js';
import { log } from './subscribers.js';
import { readSmsConfig, sendSms, smsConfigured } from './sms.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SIGNIN = {
  codeTtl: 10 * MINUTE,          // a code works for 10 minutes
  maxAttempts: 5,                // wrong guesses before the code is thrown away
  resendGap: MINUTE,             // one SMS per number per minute
  maxPerWindow: 5,               // and at most 5 per number per 24 hours
  window: DAY,
  ipPerHour: 10,                 // codes requested per network (IP)
  ipPerDay: 20,
  sessionTtl: 90 * DAY,          // a sign-in lasts 90 days on that phone, so codes are rarely needed
};

export const SESSION_COOKIE = 'rr_mjeshtri';

export const MESSAGES = {
  phoneMissing: 'Shkruaje numrin e telefonit.',
  phoneInvalid: 'Shkruaje një numër mobil të Kosovës, p.sh. 044 123 456.',
  codeInvalid: 'Kodi nuk është i saktë. Kontrolloje dhe provo prapë.',
  codeExpired: 'Ky kod nuk vlen më. Kërko një kod të ri.',
  human: 'Konfirmo që nuk je robot dhe provo prapë.',
  tooSoon: 'Prit një minutë para se të kërkosh kod tjetër.',
  tooMany: 'Ke kërkuar shumë kode. Provo prapë nesër.',
  generic: 'Diçka nuk shkoi si duhet. Provo përsëri pas pak.',
  codeSent: 'Ta dërguam kodin me SMS. Vlen 10 minuta.',
};

export function readAppConfig(env) {
  const siteUrl = (env.SITE_URL || '').replace(/\/$/, '');
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(siteUrl);
  return {
    db: env.DB,
    siteUrl,
    local,
    appSecret: env.APP_SECRET || '',
    sms: readSmsConfig(env),
    turnstile: {
      secret: env.TURNSTILE_SECRET_KEY || '',
      verifyUrl: env.TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    },
  };
}

/** What is missing for sign-in to work. Locally, SMS and Turnstile may be absent (the code is shown on the page instead). */
export function missingConfig(cfg) {
  const missing = [];
  if (!cfg.db) missing.push('DB (D1 binding)');
  if (!cfg.siteUrl) missing.push('SITE_URL');
  if (cfg.appSecret.length < 32) missing.push('APP_SECRET (32+ characters)');
  if (!cfg.local && !smsConfigured(cfg.sms)) missing.push('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN');
  if (!cfg.local && !cfg.turnstile.secret) missing.push('TURNSTILE_SECRET_KEY');
  return missing;
}

// ---------- phone numbers ----------

/**
 * Kosovo mobile numbers only (+383 43–49, then 6 digits), in E.164. Accepts the ways people write them:
 * 044 123 456, 044-123-456, +383 44 123 456, 00383 44 123 456, 38344123456. Returns '' when it is not one.
 */
export function normalisePhone(raw) {
  let s = String(raw || '').replace(/[\s\-().\/]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  else if (/^0\d{8}$/.test(s)) s = `+383${s.slice(1)}`;
  else if (/^383\d{8}$/.test(s)) s = `+${s}`;
  return /^\+3834[3-9]\d{6}$/.test(s) ? s : '';
}

/** For display: +383 44 123 456 */
export function formatPhone(e164) {
  const d = e164.slice(4);
  return `+383 ${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5)}`;
}

// ---------- abuse protection ----------

async function verifyHuman(cfg, token, ip) {
  if (!cfg.turnstile.secret) return cfg.local;   // only local development may skip the check
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const form = new URLSearchParams({ secret: cfg.turnstile.secret, response: token });
  if (ip) form.set('remoteip', ip);
  try {
    const res = await fetch(cfg.turnstile.verifyUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    return data.success === true;
  } catch (e) {
    log('turnstile_unreachable', { reason: e.name });
    return false;
  }
}

/** True when this network has asked for too many codes. Records the request otherwise. */
async function ipLimited(cfg, ip, now) {
  const bucket = await hmac(cfg.appSecret, 'sms-ip', `${ip || 'unknown'}|${Math.floor(now / DAY)}`);
  const row = await cfg.db.prepare(
    'SELECT SUM(CASE WHEN at > ?2 THEN 1 ELSE 0 END) AS hour, COUNT(*) AS day FROM rate_events WHERE bucket = ?1 AND at > ?3',
  ).bind(bucket, now - HOUR, now - DAY).first();
  if ((row?.hour || 0) >= SIGNIN.ipPerHour || (row?.day || 0) >= SIGNIN.ipPerDay) return true;
  await cfg.db.prepare('INSERT INTO rate_events (bucket, at) VALUES (?1, ?2)').bind(bucket, now).run();
  return false;
}

const codeHash = (cfg, phone, code) => hmac(cfg.appSecret, 'sms-code', `${phone}|${code}`);

function randomCode() {
  // 6 digits, uniform: reject values that would bias the modulo.
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= 4294000000);
  return String(buf[0] % 1000000).padStart(6, '0');
}

// ---------- sending a code ----------

/**
 * Sends a sign-in code. The answer is the same whether or not the number already has an account,
 * so the form never reveals who is a mjeshtër on Rregullo.
 * @returns {{ result: 'sent' | 'human' | 'too_soon' | 'too_many' | 'failed', devCode?: string }}
 */
export async function requestCode(cfg, phone, { turnstileToken, ip }, now) {
  if (!(await verifyHuman(cfg, turnstileToken, ip))) { log('signin_human_check_failed'); return { result: 'human' }; }

  const db = cfg.db;
  const row = await db.prepare('SELECT sent_count, window_start, last_sent_at FROM sms_codes WHERE phone = ?1').bind(phone).first();
  const fresh = !row || now - row.window_start >= SIGNIN.window;
  if (row && now - row.last_sent_at < SIGNIN.resendGap) { log('signin_code_too_soon'); return { result: 'too_soon' }; }
  if (!fresh && row.sent_count >= SIGNIN.maxPerWindow) { log('signin_code_daily_cap'); return { result: 'too_many' }; }
  if (await ipLimited(cfg, ip, now)) { log('signin_ip_limited'); return { result: 'too_many' }; }

  const code = randomCode();
  // Store first, so a code that reaches the phone always works. A failed send is rolled back below.
  await db.prepare(
    `INSERT INTO sms_codes (phone, code_hash, expires_at, attempts, sent_count, window_start, last_sent_at)
     VALUES (?1, ?2, ?3, 0, 1, ?4, ?4)
     ON CONFLICT (phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0,
       sent_count = CASE WHEN ?5 THEN 1 ELSE sms_codes.sent_count + 1 END,
       window_start = CASE WHEN ?5 THEN excluded.window_start ELSE sms_codes.window_start END,
       last_sent_at = excluded.last_sent_at`,
  ).bind(phone, await codeHash(cfg, phone, code), now + SIGNIN.codeTtl, now, fresh ? 1 : 0).run();

  if (!smsConfigured(cfg.sms)) {
    // Local development without an SMS account: the page shows the code instead.
    log('signin_code_dev');
    return { result: 'sent', devCode: cfg.local ? code : undefined };
  }
  try {
    await sendSms(cfg.sms, phone, `${code} është kodi yt për Rregullo. Vlen 10 minuta. Mos ia jep askujt.`);
    log('signin_code_sent');
    return { result: 'sent' };
  } catch (e) {
    // A failed send doesn't count towards the limits and leaves no usable code.
    await db.prepare(
      `UPDATE sms_codes SET code_hash = NULL, expires_at = NULL, sent_count = MAX(sent_count - 1, 0),
         last_sent_at = ?2 - ?3 WHERE phone = ?1`,
    ).bind(phone, now, SIGNIN.resendGap).run();
    log('signin_code_send_failed', { reason: e.message });
    return { result: 'failed' };
  }
}

// ---------- checking a code ----------

/** @returns {{ result: 'ok', proId: string, token: string } | { result: 'invalid' | 'expired' }} */
export async function verifyCode(cfg, phone, code, now) {
  const db = cfg.db;
  const row = await db.prepare('SELECT code_hash, expires_at, attempts FROM sms_codes WHERE phone = ?1').bind(phone).first();
  if (!row || !row.code_hash) return { result: 'expired' };
  if (row.expires_at < now) {
    await db.prepare('UPDATE sms_codes SET code_hash = NULL WHERE phone = ?1').bind(phone).run();
    return { result: 'expired' };
  }
  if (!safeEqual(await codeHash(cfg, phone, code), row.code_hash)) {
    // Count the miss; on the last allowed one the code is thrown away.
    await db.prepare(
      `UPDATE sms_codes SET attempts = attempts + 1,
         code_hash = CASE WHEN attempts + 1 >= ?2 THEN NULL ELSE code_hash END WHERE phone = ?1`,
    ).bind(phone, SIGNIN.maxAttempts).run();
    log('signin_code_wrong');
    return { result: row.attempts + 1 >= SIGNIN.maxAttempts ? 'expired' : 'invalid' };
  }
  // Single use: only the request that clears this exact hash signs in.
  const used = await db.prepare('UPDATE sms_codes SET code_hash = NULL WHERE phone = ?1 AND code_hash = ?2')
    .bind(phone, row.code_hash).run();
  if (!used.meta || used.meta.changes !== 1) return { result: 'expired' };

  await db.prepare(
    `INSERT INTO pros (id, phone, created_at, updated_at, last_login_at) VALUES (?1, ?2, ?3, ?3, ?3)
     ON CONFLICT (phone) DO UPDATE SET last_login_at = excluded.last_login_at`,
  ).bind(uuid(), phone, now).run();
  const pro = await db.prepare('SELECT id FROM pros WHERE phone = ?1').bind(phone).first();
  const token = randomToken();
  await db.prepare('INSERT INTO sessions (token_hash, kind, subject, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(await sha256(token), 'pro', pro.id, now, now + SIGNIN.sessionTtl).run();
  log('signin_ok');
  return { result: 'ok', proId: pro.id, token };
}

// ---------- sessions ----------

export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

export function sessionCookie(cfg, token, maxAgeMs) {
  const secure = cfg.local ? '' : ' Secure;';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

/** The signed-in mjeshtër for this request, or null. */
export async function currentPro(cfg, request, now) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return cfg.db.prepare(
    `SELECT p.id, p.phone, p.name, p.status FROM sessions s JOIN pros p ON p.id = s.subject
     WHERE s.token_hash = ?1 AND s.kind = 'pro' AND s.expires_at > ?2`,
  ).bind(await sha256(token), now).first();
}

export async function endSession(cfg, request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  await cfg.db.prepare("DELETE FROM sessions WHERE token_hash = ?1 AND kind = 'pro'").bind(await sha256(token)).run();
  log('signout');
}

/** Background cleanup after sign-in requests: expired sessions, codes and rate records. */
export async function signinMaintenance(cfg, now) {
  const db = cfg.db;
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now),
    db.prepare('DELETE FROM sms_codes WHERE window_start < ?1 AND (expires_at IS NULL OR expires_at < ?2)').bind(now - SIGNIN.window, now),
    db.prepare('DELETE FROM rate_events WHERE at < ?1').bind(now - DAY),
  ]);
}
