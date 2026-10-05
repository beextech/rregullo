// The mjeshtër sign-in API. JSON in and out, same-site only.
//   POST /api/mjeshtri/kodi   { phone, turnstile }  sends a 6-digit code by SMS
//   POST /api/mjeshtri/hyr    { phone, code }       checks it and sets the session cookie
//   GET  /api/mjeshtri/une                          who is signed in (401 if nobody)
//   POST /api/mjeshtri/dil                          signs out

import { log } from '../../server/subscribers.js';
import {
  MESSAGES, SIGNIN, currentPro, endSession, formatPhone, missingConfig, normalisePhone, readAppConfig,
  requestCode, sessionCookie, signinMaintenance, verifyCode,
} from '../../server/signin.js';

const MAX_BODY = 4096;

function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers,
    },
  });
}

const fail = (status, message, extra = {}) => json(status, { ok: false, message, ...extra });

function originHost(origin) {
  try { return new URL(origin).host; } catch { return null; }
}

/**
 * Same-site JSON only. A cross-site page can't send application/json without a CORS preflight, which this API
 * never answers, and a browser always sends Origin on a POST; so neither a form nor a script elsewhere can call it.
 */
async function readJson(request) {
  const origin = request.headers.get('Origin');
  if (origin && originHost(origin) !== new URL(request.url).host) return { error: fail(403, MESSAGES.generic) };
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return { error: fail(415, MESSAGES.generic) };
  const raw = await request.text();
  if (raw.length > MAX_BODY) return { error: fail(413, MESSAGES.generic) };
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return { data };
  } catch {
    return { error: fail(400, MESSAGES.generic) };
  }
}

function setup(env) {
  const cfg = readAppConfig(env);
  const missing = missingConfig(cfg);
  if (missing.length) { log('config_missing', { missing }); return { error: fail(503, MESSAGES.generic) }; }
  return { cfg };
}

const notAllowed = (allow) => () => new Response('Method Not Allowed', { status: 405, headers: { Allow: allow } });

export const kodi = {
  async onRequestPost({ request, env, waitUntil }) {
    const { data, error } = await readJson(request);
    if (error) return error;
    const phone = normalisePhone(data.phone);
    if (!phone) return fail(400, data.phone ? MESSAGES.phoneInvalid : MESSAGES.phoneMissing, { field: 'phone' });
    const { cfg, error: cfgError } = setup(env);
    if (cfgError) return cfgError;

    const now = Date.now();
    try {
      const out = await requestCode(cfg, phone, { turnstileToken: data.turnstile, ip: request.headers.get('CF-Connecting-IP') }, now);
      waitUntil(signinMaintenance(cfg, now).catch((e) => log('maintenance_failed', { reason: e.message })));
      switch (out.result) {
        case 'sent': return json(200, { ok: true, message: MESSAGES.codeSent, phone: formatPhone(phone), ...(out.devCode ? { devCode: out.devCode } : {}) });
        case 'human': return fail(400, MESSAGES.human, { field: 'turnstile' });
        case 'too_soon': return fail(429, MESSAGES.tooSoon);
        case 'too_many': return fail(429, MESSAGES.tooMany);
        default: return fail(502, MESSAGES.generic);
      }
    } catch (e) {
      log('signin_code_error', { reason: e.message });
      return fail(500, MESSAGES.generic);
    }
  },
  onRequest: notAllowed('POST'),
};

export const hyr = {
  async onRequestPost({ request, env }) {
    const { data, error } = await readJson(request);
    if (error) return error;
    const phone = normalisePhone(data.phone);
    if (!phone) return fail(400, MESSAGES.phoneInvalid, { field: 'phone' });
    const code = String(data.code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) return fail(400, MESSAGES.codeInvalid, { field: 'code' });
    const { cfg, error: cfgError } = setup(env);
    if (cfgError) return cfgError;

    try {
      const out = await verifyCode(cfg, phone, code, Date.now());
      if (out.result === 'ok') {
        return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(cfg, out.token, SIGNIN.sessionTtl) });
      }
      return fail(400, out.result === 'expired' ? MESSAGES.codeExpired : MESSAGES.codeInvalid, { field: 'code', expired: out.result === 'expired' });
    } catch (e) {
      log('signin_verify_error', { reason: e.message });
      return fail(500, MESSAGES.generic);
    }
  },
  onRequest: notAllowed('POST'),
};

export const une = {
  async onRequestGet({ request, env }) {
    const { cfg, error } = setup(env);
    if (error) return error;
    try {
      const pro = await currentPro(cfg, request, Date.now());
      if (!pro) return fail(401, 'Nuk je i kyçur.');
      return json(200, { ok: true, pro: { phone: formatPhone(pro.phone), name: pro.name, status: pro.status } });
    } catch (e) {
      log('session_error', { reason: e.message });
      return fail(500, MESSAGES.generic);
    }
  },
  onRequest: notAllowed('GET'),
};

export const dil = {
  async onRequestPost({ request, env }) {
    const { error } = await readJson(request);
    if (error) return error;
    const { cfg, error: cfgError } = setup(env);
    if (cfgError) return cfgError;
    try {
      await endSession(cfg, request);
    } catch (e) {
      log('signout_error', { reason: e.message });
    }
    // The cookie is cleared even if the database call failed.
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(cfg, '', 0) });
  },
  onRequest: notAllowed('POST'),
};
