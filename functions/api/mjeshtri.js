// The mjeshtër API. JSON in and out (photo uploads send the JPEG itself), same-site only.
// Signing in (step 1):
//   POST /api/mjeshtri/kodi           { phone, turnstile }  sends a 6-digit code by SMS
//   POST /api/mjeshtri/hyr            { phone, code }       checks it and sets the session cookie
//   GET  /api/mjeshtri/une                                  everything the dashboard shows (401 if nobody is signed in)
//   POST /api/mjeshtri/dil            { all? }              signs out (all: on every phone)
// The dashboard (step 2), signed in only:
//   POST /api/mjeshtri/profili        { name, about, trades, towns, years, priceNote, whatsapp, viber }
//   POST /api/mjeshtri/disponueshem   { available }         the "Marr punë tani" switch
//   POST /api/mjeshtri/dergo                                sends the profile for approval
//   POST /api/mjeshtri/foto?lloji=profili|pune  (image/jpeg body)  adds a photo
//   POST /api/mjeshtri/foto/fshi      { id }                deletes a photo
//   POST /api/mjeshtri/foto/renditja  { ids }               orders the work photos
//   POST /api/mjeshtri/fshi           { confirm: 'FSHIJE' } deletes the account

import { log } from '../../server/subscribers.js';
import { PHOTO, PHOTO_MESSAGES, deletePhoto, orderPhotos, savePhoto } from '../../server/photos.js';
import {
  PROFILE_MESSAGES, deleteAccount, endAllSessions, loadDashboard, saveProfile, setAvailable, submitProfile, validateProfile,
} from '../../server/profile.js';
import {
  MESSAGES, SIGNIN, currentPro, endSession, formatPhone, missingConfig, missingCoreConfig, normalisePhone, readAppConfig,
  requestCode, sessionCookie, signinMaintenance, verifyCode,
} from '../../server/signin.js';

const MAX_BODY = 8192;

function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers,
    },
  });
}

const fail = (status, message, extra = {}) => json(status, { ok: false, message, ...extra });

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

// The whole origin, scheme included: a page on http://rregullo.net (say, on hostile Wi-Fi) is not this site.
function crossSite(request) {
  const origin = request.headers.get('Origin');
  return Boolean(origin) && originOf(origin) !== new URL(request.url).origin;
}

const mediaType = (request) => (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();

/**
 * Reads the body, but never more than max bytes: null when it is longer. A Content-Length over the cap is refused
 * before reading; without one (chunked, some HTTP/2 clients) the reading stops as soon as the cap is passed.
 */
async function readCapped(request, max) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
}

/**
 * Same-site JSON only. A cross-site page can't send application/json without a CORS preflight, which this API
 * never answers, and a browser always sends Origin on a POST; so neither a form nor a script elsewhere can call it.
 */
async function readJson(request) {
  if (crossSite(request)) return { error: fail(403, MESSAGES.generic) };
  if (mediaType(request) !== 'application/json') return { error: fail(415, MESSAGES.generic) };
  const bytes = await readCapped(request, MAX_BODY);
  if (!bytes) return { error: fail(413, MESSAGES.generic) };
  try {
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return { data };
  } catch {
    return { error: fail(400, MESSAGES.generic) };
  }
}

/** A photo upload: same-site, image/jpeg (which, like JSON, needs a preflight cross-site), at most PHOTO.maxBytes. */
async function readJpeg(request) {
  if (crossSite(request)) return { error: fail(403, MESSAGES.generic) };
  if (mediaType(request) !== 'image/jpeg') {
    return { error: fail(415, PHOTO_MESSAGES.invalid) };
  }
  const bytes = await readCapped(request, PHOTO.maxBytes);
  if (!bytes) return { error: fail(413, PHOTO_MESSAGES.tooBig) };
  if (!bytes.byteLength) return { error: fail(400, PHOTO_MESSAGES.invalid) };
  return { bytes };
}

function setup(env, check = missingConfig) {
  const cfg = readAppConfig(env);
  const missing = check(cfg);
  if (missing.length) { log('config_missing', { missing }); return { error: fail(503, MESSAGES.generic) }; }
  return { cfg };
}

const SIGNED_OUT = 'Nuk je i kyçur. Hyr prapë me numrin e telefonit.';

/**
 * Wraps a signed-in endpoint: checks the request (JSON by default), the settings and the session, then calls
 * handler({ cfg, pro, data | bytes, request, url, waitUntil }). Errors become a generic 500 with no details.
 */
function signedIn(handler, { body = 'json', event } = {}) {
  return async ({ request, env, waitUntil }) => {
    let input = {};
    if (request.method === 'POST') {
      // Check the session before reading a photo, so nobody can make the Worker read 2 MB without being signed in.
      if (body === 'jpeg' && crossSite(request)) return fail(403, MESSAGES.generic);
      if (body === 'json') {
        input = await readJson(request);
        if (input.error) return input.error;
      }
    }
    const { cfg, error } = setup(env, missingCoreConfig);
    if (error) return error;
    try {
      const now = Date.now();
      const pro = await currentPro(cfg, request, now);
      if (!pro) return fail(401, SIGNED_OUT, { signedOut: true });
      if (body === 'jpeg') {
        input = await readJpeg(request);
        if (input.error) return input.error;
      }
      return await handler({ cfg, pro, now, data: input.data, bytes: input.bytes, request, url: new URL(request.url), waitUntil });
    } catch (e) {
      log(event || 'dashboard_error', { reason: e.message });
      return fail(500, MESSAGES.generic);
    }
  };
}

/** The dashboard's state after a change, so the page redraws from what was actually saved. */
async function dashboard(cfg, pro, now, extra = {}) {
  const state = await loadDashboard(cfg, pro.id, now);
  if (!state) return fail(401, SIGNED_OUT, { signedOut: true });
  return json(200, { ok: true, ...extra, dashboard: state });
}

const suspended = (pro) => pro.status === 'suspended';

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
  onRequestGet: signedIn(({ cfg, pro, now }) => dashboard(cfg, pro, now), { event: 'session_error' }),
  onRequest: notAllowed('GET'),
};

export const dil = {
  async onRequestPost({ request, env }) {
    const { data, error } = await readJson(request);
    if (error) return error;
    const { cfg, error: cfgError } = setup(env, missingCoreConfig);
    if (cfgError) return cfgError;
    try {
      if (data.all === true) {
        const pro = await currentPro(cfg, request, Date.now());
        if (pro) await endAllSessions(cfg, pro.id);
      }
      await endSession(cfg, request);
    } catch (e) {
      log('signout_error', { reason: e.message });
    }
    // The cookie is cleared even if the database call failed.
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(cfg, '', 0) });
  },
  onRequest: notAllowed('POST'),
};

export const profili = {
  onRequestPost: signedIn(async ({ cfg, pro, now, data }) => {
    if (suspended(pro)) return fail(403, PROFILE_MESSAGES.suspended);
    const { profile, errors } = validateProfile(data, { live: pro.status === 'pending' || pro.status === 'approved' });
    if (Object.keys(errors).length) return fail(400, PROFILE_MESSAGES.invalid, { errors });
    await saveProfile(cfg, pro.id, profile, now);
    return dashboard(cfg, pro, now, { message: PROFILE_MESSAGES.saved });
  }, { event: 'profile_error' }),
  onRequest: notAllowed('POST'),
};

export const disponueshem = {
  onRequestPost: signedIn(async ({ cfg, pro, now, data }) => {
    if (typeof data.available !== 'boolean') return fail(400, MESSAGES.generic);
    if (suspended(pro)) return fail(403, PROFILE_MESSAGES.suspended);
    await setAvailable(cfg, pro.id, data.available, now);
    return dashboard(cfg, pro, now);
  }, { event: 'available_error' }),
  onRequest: notAllowed('POST'),
};

export const dergo = {
  onRequestPost: signedIn(async ({ cfg, pro, now }) => {
    const out = await submitProfile(cfg, pro.id, now);
    switch (out.result) {
      case 'submitted': return dashboard(cfg, pro, now, { message: PROFILE_MESSAGES.submitted });
      case 'pending': return dashboard(cfg, pro, now, { message: PROFILE_MESSAGES.alreadyPending });
      case 'approved': return dashboard(cfg, pro, now, { message: PROFILE_MESSAGES.alreadyApproved });
      case 'suspended': return fail(403, PROFILE_MESSAGES.suspended);
      default: return fail(400, PROFILE_MESSAGES.incomplete, { missing: out.missing });
    }
  }, { event: 'submit_error' }),
  onRequest: notAllowed('POST'),
};

const photosReady = (cfg) => (cfg.photos ? null : fail(503, PHOTO_MESSAGES.unavailable));

export const foto = {
  onRequestPost: signedIn(async ({ cfg, pro, now, bytes, url }) => {
    const kind = { profili: 'profile', pune: 'work' }[url.searchParams.get('lloji')];
    if (!kind) return fail(400, PHOTO_MESSAGES.invalid);
    if (suspended(pro)) return fail(403, PROFILE_MESSAGES.suspended);
    const notReady = photosReady(cfg);
    if (notReady) return notReady;
    const out = await savePhoto(cfg, pro.id, kind, bytes, now);
    switch (out.result) {
      case 'ok': return dashboard(cfg, pro, now, { photo: out.photo });
      case 'limit': return fail(400, PHOTO_MESSAGES.limit);
      case 'too_many_today': return fail(429, PHOTO_MESSAGES.tooManyToday);
      default: return fail(400, PHOTO_MESSAGES.invalid);
    }
  }, { body: 'jpeg', event: 'photo_error' }),
  onRequest: notAllowed('POST'),
};

export const fotoFshi = {
  onRequestPost: signedIn(async ({ cfg, pro, now, data }) => {
    if (suspended(pro)) return fail(403, PROFILE_MESSAGES.suspended);
    const notReady = photosReady(cfg);
    if (notReady) return notReady;
    const out = await deletePhoto(cfg, pro.id, data.id);
    if (out.result !== 'ok') return fail(404, PHOTO_MESSAGES.notFound);
    return dashboard(cfg, pro, now);
  }, { event: 'photo_delete_error' }),
  onRequest: notAllowed('POST'),
};

export const fotoRenditja = {
  onRequestPost: signedIn(async ({ cfg, pro, now, data }) => {
    if (suspended(pro)) return fail(403, PROFILE_MESSAGES.suspended);
    const out = await orderPhotos(cfg, pro.id, data.ids);
    if (out.result !== 'ok') return fail(400, PHOTO_MESSAGES.orderInvalid);
    return dashboard(cfg, pro, now);
  }, { event: 'photo_order_error' }),
  onRequest: notAllowed('POST'),
};

export const fshi = {
  onRequestPost: signedIn(async ({ cfg, pro, now, data }) => {
    if (data.confirm !== 'FSHIJE') return fail(400, MESSAGES.generic);
    const { kept } = await deleteAccount(cfg, pro, now);
    const message = kept ? PROFILE_MESSAGES.deletedSuspended : PROFILE_MESSAGES.deleted;
    return json(200, { ok: true, message }, { 'Set-Cookie': sessionCookie(cfg, '', 0) });
  }, { event: 'account_delete_error' }),
  onRequest: notAllowed('POST'),
};
