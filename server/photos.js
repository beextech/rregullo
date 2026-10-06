// Mjeshtër photos: a profile photo and up to 12 work photos. The phone shrinks each photo to a JPEG before upload
// (src/mjeshtri/photo.js); the Worker checks it really is one, keeps it in R2 (binding PHOTOS) as foto/<id>.jpg,
// and lists it in pro_photos. Photos are served at /foto/<id>.jpg: the id is a random UUID, so a photo can only be
// found through the profile it belongs to.

import { hmac, uuid } from './crypto.js';
import { jpegInfo } from './jpeg.js';
import { photoUrl } from './profile.js';
import { log } from './subscribers.js';

const DAY = 24 * 60 * 60 * 1000;

export const PHOTO = {
  maxBytes: 2 * 1024 * 1024,     // the phone sends about 150–500 KB; anything above 2 MB was not shrunk by us
  maxWork: 12,
  minEdge: 200,                  // shorter side, in pixels
  maxEdge: 2048,                 // longer side; the phone sends at most 1600
  uploadsPerDay: 60,             // per mjeshtër, so a stuck script can't fill the bucket
};

export const PHOTO_MESSAGES = {
  invalid: 'Kjo foto nuk u lexua. Provo një foto tjetër.',
  tooBig: 'Kjo foto është shumë e madhe. Provo një foto tjetër.',
  limit: `Mund të kesh deri në ${PHOTO.maxWork} foto të punëve. Fshije një për të shtuar një tjetër.`,
  tooManyToday: 'Ke ngarkuar shumë foto sot. Provo prapë nesër.',
  notFound: 'Kjo foto nuk u gjet. Rifreskoje faqen.',
  unavailable: 'Fotot nuk mund të ngarkohen tani. Provo përsëri më vonë.',
  orderInvalid: 'Renditja nuk u ruajt. Rifreskoje faqen dhe provo prapë.',
};

const keyOf = (id) => `foto/${id}.jpg`;
export const PHOTO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function uploadedTooMuch(cfg, proId, now) {
  const bucket = await hmac(cfg.appSecret, 'photo-upload', proId);
  const row = await cfg.db.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ?1 AND at > ?2').bind(bucket, now - DAY).first();
  if ((row?.n || 0) >= PHOTO.uploadsPerDay) return true;
  await cfg.db.prepare('INSERT INTO rate_events (bucket, at) VALUES (?1, ?2)').bind(bucket, now).run();
  return false;
}

/**
 * Stores an uploaded photo. A new profile photo replaces the old one.
 * @returns {{ result: 'ok', photo: object } | { result: 'invalid' | 'limit' | 'too_many_today' }}
 */
export async function savePhoto(cfg, proId, kind, bytes, now) {
  const info = jpegInfo(bytes);
  if (!info || Math.min(info.width, info.height) < PHOTO.minEdge || Math.max(info.width, info.height) > PHOTO.maxEdge) {
    log('photo_rejected', { reason: info ? 'size' : 'not_jpeg' });
    return { result: 'invalid' };
  }
  const db = cfg.db;
  if (kind === 'work') {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM pro_photos WHERE pro_id = ?1 AND kind = 'work'").bind(proId).first();
    if (row.n >= PHOTO.maxWork) return { result: 'limit' };
  }
  if (await uploadedTooMuch(cfg, proId, now)) { log('photo_daily_cap'); return { result: 'too_many_today' }; }

  const id = uuid();
  await cfg.photos.put(keyOf(id), bytes, { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: { kind } });
  try {
    if (kind === 'work') {
      // The count is checked again in the same statement, so two uploads at once can't pass the limit.
      const res = await db.prepare(
        `INSERT INTO pro_photos (id, pro_id, kind, width, height, bytes, position, created_at)
         SELECT ?1, ?2, 'work', ?3, ?4, ?5,
                COALESCE((SELECT MAX(position) FROM pro_photos WHERE pro_id = ?2 AND kind = 'work'), -1) + 1, ?6
         WHERE (SELECT COUNT(*) FROM pro_photos WHERE pro_id = ?2 AND kind = 'work') < ?7`,
      ).bind(id, proId, info.width, info.height, bytes.byteLength, now, PHOTO.maxWork).run();
      if (!res.meta || res.meta.changes !== 1) {
        await cfg.photos.delete(keyOf(id));
        return { result: 'limit' };
      }
    } else {
      // One transaction: the new profile photo goes in and every older one comes out.
      const [, removed] = await db.batch([
        db.prepare(`INSERT INTO pro_photos (id, pro_id, kind, width, height, bytes, position, created_at)
                    VALUES (?1, ?2, 'profile', ?3, ?4, ?5, 0, ?6)`).bind(id, proId, info.width, info.height, bytes.byteLength, now),
        db.prepare("DELETE FROM pro_photos WHERE pro_id = ?1 AND kind = 'profile' AND id != ?2 RETURNING id").bind(proId, id),
      ]);
      const old = (removed.results || []).map((r) => keyOf(r.id));
      if (old.length) await cfg.photos.delete(old).catch((e) => log('photo_cleanup_failed', { reason: e.message }));
    }
  } catch (e) {
    await cfg.photos.delete(keyOf(id)).catch(() => {});
    throw e;
  }
  log('photo_saved', { kind });
  return { result: 'ok', photo: { id, url: photoUrl(id), width: info.width, height: info.height } };
}

/** Deletes one of this mjeshtër's photos: from R2 first, so the listing never points at a missing file. */
export async function deletePhoto(cfg, proId, id) {
  if (typeof id !== 'string' || !PHOTO_ID.test(id)) return { result: 'not_found' };
  const row = await cfg.db.prepare('SELECT id FROM pro_photos WHERE id = ?1 AND pro_id = ?2').bind(id, proId).first();
  if (!row) return { result: 'not_found' };
  await cfg.photos.delete(keyOf(id));
  await cfg.db.prepare('DELETE FROM pro_photos WHERE id = ?1 AND pro_id = ?2').bind(id, proId).run();
  log('photo_deleted');
  return { result: 'ok' };
}

/** Puts the work photos in the given order. The list must hold exactly this mjeshtër's work photos. */
export async function orderPhotos(cfg, proId, ids) {
  if (!Array.isArray(ids) || ids.length > PHOTO.maxWork || new Set(ids).size !== ids.length) return { result: 'invalid' };
  const db = cfg.db;
  const { results } = await db.prepare("SELECT id FROM pro_photos WHERE pro_id = ?1 AND kind = 'work'").bind(proId).all();
  const mine = new Set(results.map((r) => r.id));
  if (ids.length !== mine.size || !ids.every((id) => mine.has(id))) return { result: 'invalid' };
  if (ids.length) {
    await db.batch(ids.map((id, i) => db.prepare('UPDATE pro_photos SET position = ?3 WHERE id = ?1 AND pro_id = ?2').bind(id, proId, i)));
  }
  return { result: 'ok' };
}

// A well-formed If-None-Match only: R2 throws on an unquoted ETag, and other conditional headers (If-Match,
// If-Unmodified-Since) would make get() hand back a body-less object that reads as "not modified".
const IF_NONE_MATCH = /^\s*(\*|(W\/)?"[\x21\x23-\x7e]*"(\s*,\s*(W\/)?"[\x21\x23-\x7e]*")*)\s*$/;

function stillCurrent(inm, etag) {
  return inm.trim() === '*' || inm.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
}

/** GET /foto/<id>.jpg straight from R2, cached for a year (a changed photo always gets a new id). */
export async function servePhoto(photos, request, id) {
  const head = request.method === 'HEAD';
  const notFound = () => new Response(head ? null : 'Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (!photos || !PHOTO_ID.test(id)) return notFound();
  const inm = request.headers.get('If-None-Match');
  const conditional = Boolean(inm) && IF_NONE_MATCH.test(inm);
  const obj = head
    ? await photos.head(keyOf(id))
    : await photos.get(keyOf(id), conditional ? { onlyIf: new Headers({ 'If-None-Match': inm }) } : {});
  if (!obj) return notFound();
  const headers = new Headers({
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: obj.httpEtag,
    'Last-Modified': obj.uploaded.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-site',
  });
  // get() with onlyIf hands back the object without a body when the browser's copy is still current.
  const current = head ? conditional && stillCurrent(inm, obj.httpEtag) : !('body' in obj);
  if (current) return new Response(null, { status: 304, headers });
  headers.set('Content-Length', String(obj.size));
  return new Response(head ? null : obj.body, { status: 200, headers });
}
