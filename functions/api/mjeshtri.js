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
// Reviews (step 5), signed in only:
//   POST /api/mjeshtri/pergjigju      { id, text }          the one public reply to a review
//   POST /api/mjeshtri/raporto        { id, reason }        asks the team to look at a review

import { log } from '../../server/subscribers.js';
import { notifyQueue } from '../../server/admin.js';
import { crossSite, fail, json, notAllowed, readJpeg, readJson } from '../../server/http.js';
import { PHOTO_MESSAGES, deletePhoto, orderPhotos, savePhoto } from '../../server/photos.js';
import { REVIEW_MESSAGES, replyToReview, reportReview } from '../../server/reviews.js';
import {
  PROFILE_MESSAGES, deleteAccount, endAllSessions, loadDashboard, markEdited, saveProfile, setAvailable, submitProfile,
  validateProfile,
} from '../../server/profile.js';
import {
  MESSAGES, SIGNIN, currentPro, endSession, formatPhone, missingConfig, missingCoreConfig, normalisePhone, readAppConfig,
  requestCode, sessionCookie, signinMaintenance, verifyCode,
} from '../../server/signin.js';

function setup(env, check = missingConfig) {
  const cfg = readAppConfig(env);
  const missing = check(cfg);
  if (missing.length) { log('config_missing', { missing }); return { error: fail(503, MESSAGES.generic) }; }
  return { cfg };
}

const SIGNED_OUT = 'Nuk je i kyçur. Hyr prapë me numrin e telefonit.';

/**
 * Wraps a signed-in endpoint: checks the request (JSON by default), the settings and the session, then calls
 * handler({ cfg, pro, data | bytes, request, url, env, waitUntil }). Errors become a generic 500 with no details.
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
      return await handler({ cfg, pro, now, data: input.data, bytes: input.bytes, request, url: new URL(request.url), env, waitUntil });
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
  onRequestPost: signedIn(async ({ cfg, pro, now, env, waitUntil }) => {
    const out = await submitProfile(cfg, pro.id, now);
    switch (out.result) {
      case 'submitted':
        // The team hears that the queue has something new (at most one email an hour), after the answer.
        waitUntil(notifyQueue(env, now).catch((e) => log('admin_queue_email_failed', { reason: e.message })));
        return dashboard(cfg, pro, now, { message: PROFILE_MESSAGES.submitted });
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
      case 'ok':
        await markEdited(cfg, pro.id, now);
        return dashboard(cfg, pro, now, { photo: out.photo });
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
    await markEdited(cfg, pro.id, now);
    return dashboard(cfg, pro, now);
  }, { event: 'photo_delete_error' }),
  onRequest: notAllowed('POST'),
};

export const fotoRenditja = {
  onRequestPost: signedIn(async ({ cfg, pro, now, data }) => {
    if (suspended(pro)) return fail(403, PROFILE_MESSAGES.suspended);
    const out = await orderPhotos(cfg, pro.id, data.ids);
    if (out.result !== 'ok') return fail(400, PHOTO_MESSAGES.orderInvalid);
    await markEdited(cfg, pro.id, now);
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

// What a reply or report answered, as the dashboard's answer.
async function reviewAnswer(cfg, pro, now, out, okMessage, alreadyMessage) {
  if (out.result === 'ok') return dashboard(cfg, pro, now, { message: okMessage });
  if (out.result === 'invalid') return fail(400, out.message, { field: 'text' });
  if (out.result === 'already') return fail(409, alreadyMessage);
  return fail(404, REVIEW_MESSAGES.notFound);
}

export const pergjigju = {
  onRequestPost: signedIn(async ({ cfg, pro, now, data }) => {
    if (suspended(pro)) return fail(403, PROFILE_MESSAGES.suspended);
    const out = await replyToReview(cfg, pro.id, data.id, data.text, now);
    return reviewAnswer(cfg, pro, now, out, REVIEW_MESSAGES.replied, REVIEW_MESSAGES.alreadyReplied);
  }, { event: 'review_reply_error' }),
  onRequest: notAllowed('POST'),
};

export const raporto = {
  onRequestPost: signedIn(async ({ cfg, pro, now, data, env, waitUntil }) => {
    if (suspended(pro)) return fail(403, PROFILE_MESSAGES.suspended);
    const out = await reportReview(cfg, pro.id, data.id, data.reason, now);
    // The team hears about it with the queue email (at most one an hour).
    if (out.result === 'ok') waitUntil(notifyQueue(env, now).catch((e) => log('admin_queue_email_failed', { reason: e.message })));
    return reviewAnswer(cfg, pro, now, out, REVIEW_MESSAGES.reported, REVIEW_MESSAGES.alreadyReported);
  }, { event: 'review_report_error' }),
  onRequest: notAllowed('POST'),
};
