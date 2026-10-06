// The team admin API, behind /admin. JSON in and out (photo uploads send the JPEG itself), same-site only.
// Only the addresses in ADMIN_EMAILS can sign in; the session cookie (rr_ekipi) never opens the mjeshtër API,
// and the mjeshtër's never opens this one.
// Signing in:
//   POST /api/admin/lidhja        { email }               emails a sign-in link and code (same answer for every address)
//   POST /api/admin/hyr           { token } | { email, code }  signs in and sets the session cookie
//   GET  /api/admin/une                                   who is signed in, and what is set up (401 if nobody)
//   POST /api/admin/dil           {}                      signs out
// Signed in only:
//   POST /api/admin/mjeshtrit     { status, q }           the lists, with counts (POST, so a searched name or
//                                                          number never appears in a URL or the request logs)
//   GET  /api/admin/mjeshtri      ?id=                    one mjeshtër, with the history
//   POST /api/admin/vendim        { id, action, note?, internalNote?, notify?, seenEditedAt? }  approve, reject, ...
//   POST /api/admin/profili       { id, name, about, trades, towns, years, priceNote, whatsapp, viber }
//   POST /api/admin/foto?id=&lloji=profili|pune  (image/jpeg body)  adds a photo
//   POST /api/admin/foto/fshi     { id, photoId }         deletes a photo
//   POST /api/admin/shto          { phone, consent }      adds a mjeshtër (with their OK)
//   POST /api/admin/fshi          { id, confirm: 'FSHIJE' }  deletes a mjeshtër's account

import {
  ADMIN, ADMIN_MESSAGES, LIST_FILTERS, adminCookie, adminMaintenance, createPro, currentAdmin, decide, endAdminSession,
  linkAllowedFrom, listPros, loadPro, logAction, missingAdminConfig, readAdminConfig, readDecision, requestLink, useCode,
  useLink, validId,
} from '../../server/admin.js';
import { crossSite, fail, json, notAllowed, readJpeg, readJson } from '../../server/http.js';
import { PHOTO_MESSAGES, deletePhoto, savePhoto } from '../../server/photos.js';
import { PROFILE_MESSAGES, deleteAccount, markEdited, saveProfile, validateProfile } from '../../server/profile.js';
import { MESSAGES, normalisePhone, signinMaintenance } from '../../server/signin.js';
import { smsConfigured } from '../../server/sms.js';
import { log } from '../../server/subscribers.js';
import { isValidEmail, normaliseEmail } from '../../server/validate.js';

function setup(env, opts) {
  const cfg = readAdminConfig(env);
  const missing = missingAdminConfig(cfg, opts);
  if (missing.length) { log('config_missing', { missing }); return { error: fail(503, MESSAGES.generic) }; }
  return { cfg };
}

const readEmail = (raw) => {
  const email = normaliseEmail(raw);
  return isValidEmail(email) ? email : '';
};

/**
 * Wraps a signed-in endpoint: checks the request (JSON by default), the settings and the session, then calls
 * handler({ cfg, admin, now, data | bytes, url, waitUntil }). Errors become a generic 500 with no details.
 */
function team(handler, { body = 'json', event } = {}) {
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
    const { cfg, error } = setup(env);
    if (error) return error;
    try {
      const now = Date.now();
      const admin = await currentAdmin(cfg, request, now);
      if (!admin) return fail(401, ADMIN_MESSAGES.signedOut, { signedOut: true });
      if (body === 'jpeg') {
        input = await readJpeg(request);
        if (input.error) return input.error;
      }
      return await handler({ cfg, admin: admin.email, now, data: input.data, bytes: input.bytes, url: new URL(request.url), waitUntil });
    } catch (e) {
      log(event || 'admin_error', { reason: e.message });
      return fail(500, MESSAGES.generic);
    }
  };
}

/** The mjeshtër's state after a change, so the panel redraws from what was actually saved. */
async function withPro(cfg, id, now, extra = {}, status = 200) {
  const pro = await loadPro(cfg, id, now);
  if (!pro) return fail(404, ADMIN_MESSAGES.notFound);
  return json(status, { ok: true, ...extra, pro });
}

const photosReady = (cfg) => (cfg.photos ? null : fail(503, PHOTO_MESSAGES.unavailable));

export const lidhja = {
  async onRequestPost({ request, env, waitUntil }) {
    const { data, error } = await readJson(request);
    if (error) return error;
    const email = readEmail(data.email);
    if (!email) return fail(400, ADMIN_MESSAGES.emailInvalid, { field: 'email' });
    const { cfg, error: cfgError } = setup(env, { email: true });
    if (cfgError) return cfgError;

    const now = Date.now();
    try {
      // The network's limit is the only answer that differs, and it never depends on the address.
      if (!(await linkAllowedFrom(cfg, request.headers.get('CF-Connecting-IP'), now))) {
        log('admin_link_ip_limited');
        return fail(429, ADMIN_MESSAGES.tooMany);
      }
      waitUntil(requestLink(cfg, email, now).catch((e) => log('admin_link_error', { reason: e.message })));
      waitUntil(Promise.all([signinMaintenance(cfg, now), adminMaintenance(cfg, now)])
        .catch((e) => log('maintenance_failed', { reason: e.message })));
      return json(200, { ok: true, message: ADMIN_MESSAGES.linkSent });
    } catch (e) {
      log('admin_link_error', { reason: e.message });
      return fail(500, MESSAGES.generic);
    }
  },
  onRequest: notAllowed('POST'),
};

export const hyr = {
  async onRequestPost({ request, env }) {
    const { data, error } = await readJson(request);
    if (error) return error;
    const byToken = data.token !== undefined;
    let email = '';
    let code = '';
    if (!byToken) {
      email = readEmail(data.email);
      if (!email) return fail(400, ADMIN_MESSAGES.emailInvalid, { field: 'email' });
      code = String(data.code || '').replace(/\s/g, '');
      if (!/^\d{6}$/.test(code)) return fail(400, ADMIN_MESSAGES.codeInvalid, { field: 'code' });
    }
    const { cfg, error: cfgError } = setup(env);
    if (cfgError) return cfgError;

    try {
      const now = Date.now();
      const out = byToken ? await useLink(cfg, data.token, now) : await useCode(cfg, email, code, now);
      if (out.result === 'ok') return json(200, { ok: true }, { 'Set-Cookie': adminCookie(cfg, out.token, ADMIN.sessionTtl) });
      return byToken
        ? fail(400, ADMIN_MESSAGES.linkExpired, { expired: true })
        : fail(400, ADMIN_MESSAGES.codeInvalid, { field: 'code' });
    } catch (e) {
      log('admin_signin_error', { reason: e.message });
      return fail(500, MESSAGES.generic);
    }
  },
  onRequest: notAllowed('POST'),
};

export const une = {
  onRequestGet: team(({ cfg, admin }) => json(200, {
    ok: true, email: admin, smsEnabled: smsConfigured(cfg.sms), photosEnabled: Boolean(cfg.photos),
  }), { event: 'admin_session_error' }),
  onRequest: notAllowed('GET'),
};

export const dil = {
  async onRequestPost({ request, env }) {
    const { error } = await readJson(request);
    if (error) return error;
    const { cfg, error: cfgError } = setup(env);
    if (cfgError) return cfgError;
    try {
      await endAdminSession(cfg, request);
    } catch (e) {
      log('admin_signout_error', { reason: e.message });
    }
    // The cookie is cleared even if the database call failed.
    return json(200, { ok: true }, { 'Set-Cookie': adminCookie(cfg, '', 0) });
  },
  onRequest: notAllowed('POST'),
};

export const mjeshtrit = {
  onRequestPost: team(async ({ cfg, data }) => {
    const filter = data.status === undefined || data.status === '' ? 'all' : data.status;
    if (!LIST_FILTERS.includes(filter)) return fail(400, ADMIN_MESSAGES.statusInvalid, { field: 'status' });
    const list = await listPros(cfg, filter, typeof data.q === 'string' ? data.q : '');
    return json(200, { ok: true, ...list });
  }, { event: 'admin_list_error' }),
  onRequest: notAllowed('POST'),
};

export const mjeshtri = {
  onRequestGet: team(({ cfg, now, url }) => withPro(cfg, url.searchParams.get('id'), now), { event: 'admin_detail_error' }),
  onRequest: notAllowed('GET'),
};

export const vendim = {
  onRequestPost: team(async ({ cfg, admin, now, data }) => {
    const pro = await loadPro(cfg, data.id, now);
    if (!pro) return fail(404, ADMIN_MESSAGES.notFound);
    const d = readDecision(data);
    if (d.error) return fail(400, d.error.message, d.error.field ? { field: d.error.field } : {});
    const out = await decide(cfg, admin, pro, d, now);
    switch (out.result) {
      case 'ok': return withPro(cfg, pro.id, now, { message: out.message, sms: out.sms });
      case 'missing': return fail(400, ADMIN_MESSAGES.incomplete, { missing: out.missing });
      case 'gone': return fail(404, ADMIN_MESSAGES.notFound);
      default: {
        const fresh = await loadPro(cfg, pro.id, now);
        if (!fresh) return fail(404, ADMIN_MESSAGES.notFound);
        const message = out.result === 'edited' ? ADMIN_MESSAGES.editedMeanwhile : ADMIN_MESSAGES.notNow;
        return fail(409, message, { reason: out.result, pro: fresh });
      }
    }
  }, { event: 'admin_decision_error' }),
  onRequest: notAllowed('POST'),
};

export const profili = {
  onRequestPost: team(async ({ cfg, admin, now, data }) => {
    const pro = await loadPro(cfg, data.id, now);
    if (!pro) return fail(404, ADMIN_MESSAGES.notFound);
    const { profile, errors } = validateProfile(data, { live: pro.status === 'pending' || pro.status === 'approved' });
    if (Object.keys(errors).length) return fail(400, PROFILE_MESSAGES.invalid, { errors });
    await saveProfile(cfg, pro.id, profile, now);
    await logAction(cfg, { proId: pro.id, admin, action: 'profile' }, now);
    return withPro(cfg, pro.id, now, { message: PROFILE_MESSAGES.saved });
  }, { event: 'admin_profile_error' }),
  onRequest: notAllowed('POST'),
};

export const foto = {
  onRequestPost: team(async ({ cfg, admin, now, bytes, url }) => {
    const kind = { profili: 'profile', pune: 'work' }[url.searchParams.get('lloji')];
    if (!kind) return fail(400, PHOTO_MESSAGES.invalid);
    const id = url.searchParams.get('id');
    if (!validId(id) || !(await cfg.db.prepare('SELECT 1 FROM pros WHERE id = ?1').bind(id).first())) {
      return fail(404, ADMIN_MESSAGES.notFound);
    }
    const notReady = photosReady(cfg);
    if (notReady) return notReady;
    const out = await savePhoto(cfg, id, kind, bytes, now);
    switch (out.result) {
      case 'ok':
        await markEdited(cfg, id, now);
        await logAction(cfg, { proId: id, admin, action: 'photo', note: kind === 'profile' ? 'Foto e profilit u ndërrua.' : 'U shtua një foto pune.' }, now);
        return withPro(cfg, id, now, { photo: out.photo });
      case 'limit': return fail(400, PHOTO_MESSAGES.limit);
      case 'too_many_today': return fail(429, PHOTO_MESSAGES.tooManyToday);
      default: return fail(400, PHOTO_MESSAGES.invalid);
    }
  }, { body: 'jpeg', event: 'admin_photo_error' }),
  onRequest: notAllowed('POST'),
};

export const fotoFshi = {
  onRequestPost: team(async ({ cfg, admin, now, data }) => {
    if (!validId(data.id) || !(await cfg.db.prepare('SELECT 1 FROM pros WHERE id = ?1').bind(data.id).first())) {
      return fail(404, ADMIN_MESSAGES.notFound);
    }
    const notReady = photosReady(cfg);
    if (notReady) return notReady;
    const out = await deletePhoto(cfg, data.id, data.photoId);
    if (out.result !== 'ok') return fail(404, PHOTO_MESSAGES.notFound);
    await markEdited(cfg, data.id, now);
    await logAction(cfg, { proId: data.id, admin, action: 'photo', note: 'U fshi një foto.' }, now);
    return withPro(cfg, data.id, now);
  }, { event: 'admin_photo_delete_error' }),
  onRequest: notAllowed('POST'),
};

export const shto = {
  onRequestPost: team(async ({ cfg, admin, now, data }) => {
    const phone = normalisePhone(data.phone);
    if (!phone) return fail(400, data.phone ? MESSAGES.phoneInvalid : MESSAGES.phoneMissing, { field: 'phone' });
    if (data.consent !== true) return fail(400, ADMIN_MESSAGES.consentMissing, { field: 'consent' });
    const out = await createPro(cfg, admin, phone, now);
    switch (out.result) {
      case 'created': return json(201, { ok: true, message: ADMIN_MESSAGES.created, id: out.id });
      case 'exists': return fail(409, ADMIN_MESSAGES.exists, { id: out.id });
      default: return fail(429, ADMIN_MESSAGES.addsTooMany);
    }
  }, { event: 'admin_add_error' }),
  onRequest: notAllowed('POST'),
};

export const fshi = {
  onRequestPost: team(async ({ cfg, admin, now, data }) => {
    if (data.confirm !== 'FSHIJE') return fail(400, MESSAGES.generic, { field: 'confirm' });
    // The status is read right before deleting: a suspended number keeps its bare row (and its history).
    const pro = validId(data.id) ? await cfg.db.prepare('SELECT id, status FROM pros WHERE id = ?1').bind(data.id).first() : null;
    if (!pro) return fail(404, ADMIN_MESSAGES.notFound);
    const { kept } = await deleteAccount(cfg, pro, now);
    if (kept) await logAction(cfg, { proId: pro.id, admin, action: 'deleted' }, now);
    log('admin_pro_deleted', { kept });
    return json(200, { ok: true, message: kept ? ADMIN_MESSAGES.deletedSuspended : ADMIN_MESSAGES.deleted, kept });
  }, { event: 'admin_delete_error' }),
  onRequest: notAllowed('POST'),
};
