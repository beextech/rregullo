// Reviews (step 5). Only a client who tapped Thirre, WhatsApp or Viber can review: the tap hands their browser a
// signed receipt, and "Si shkoi?" in Thirrjet e mia uses it 12 hours to 60 days later. A review shows only after
// the client confirms it through a link sent to their email; the address is kept only until then, and afterwards
// only a keyed hash of it, so the same address reviewing the same mjeshtër again replaces its earlier review.
// The mjeshtër can reply once or report a review; the team keeps or hides a reported one.

import { b64url, hmac, randomToken, safeEqual, sha256, uuid } from './crypto.js';
import { sendEmail } from './email.js';
import { profilePath } from './handle.js';
import { cleanLine, cleanText } from './profile.js';
import { log } from './subscribers.js';
import { reviewConfirmEmail } from './templates.js';
import { isValidEmail, normaliseEmail } from './validate.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const REVIEW = {
  minAge: 12 * HOUR,        // "Si shkoi?" opens 12 hours after the tap, once the job could have happened
  maxAge: 60 * DAY,         // and closes 60 days after it
  confirmTtl: 48 * HOUR,    // the emailed link confirms for 48 hours; unconfirmed reviews are deleted after that
  comment: 600,
  author: 40,
  reply: 400,
  reportReason: 300,
  perIpHour: 5,             // review submissions from one network
  perIpDay: 20,
  perEmailDay: 5,           // confirmation emails to one address
  publicList: 50,           // reviews shown on a profile
  priorMean: 4,             // ranking: a few reviews count less than many (see rankRating)
  priorWeight: 3,
};

export const REVIEW_MESSAGES = {
  starsMissing: 'Zgjidh nga 1 deri në 5 yje.',
  commentTooLong: `Komenti mund të ketë deri në ${REVIEW.comment} shkronja.`,
  authorTooLong: `Emri mund të ketë deri në ${REVIEW.author} shkronja.`,
  emailMissing: 'Shkruaje emailin, që ta konfirmosh vlerësimin.',
  emailInvalid: 'Kjo nuk duket si email adresë e vlefshme. Shembull: emri@shembull.com',
  early: 'Mund ta vlerësosh mjeshtrin 12 orë pas thirrjes.',
  late: 'Kanë kaluar më shumë se 60 ditë nga thirrja, prandaj ky mjeshtër nuk mund të vlerësohet më nga këtu.',
  invalid: 'Ky vlerësim nuk mund të dërgohet. Thirre mjeshtrin nga Rregullo dhe provo prapë më vonë.',
  used: 'Për këtë thirrje është dhënë tashmë një vlerësim.',
  gone: 'Ky mjeshtër nuk është më në Rregullo.',
  rateLimited: 'Ke dërguar shumë vlerësime. Provo përsëri më vonë.',
  sent: 'Të dërguam një email. Kliko lidhjen në të dhe vlerësimi shfaqet.',
  replyMissing: 'Shkruaje përgjigjen.',
  replyTooLong: `Përgjigja mund të ketë deri në ${REVIEW.reply} shkronja.`,
  replied: 'Përgjigja u publikua.',
  alreadyReplied: 'Këtij vlerësimi i je përgjigjur tashmë.',
  reasonMissing: 'Shkruaje shkurt pse e raporton.',
  reasonTooLong: `Arsyeja mund të ketë deri në ${REVIEW.reportReason} shkronja.`,
  reported: 'Faleminderit. Ekipi i Rregullos do ta shikojë vlerësimin.',
  alreadyReported: 'Këtë vlerësim e ke raportuar tashmë.',
  notFound: 'Ky vlerësim nuk u gjet. Rifreskoje faqen.',
};

// ---------- the tap receipt ----------

const RECEIPT = /^([a-z0-9]{6,16})\.([0-9a-z]{1,12})\.([A-Za-z0-9_-]{16})\.([0-9a-f]{32})$/;

const receiptSig = async (cfg, handle, at, nonce) => (await hmac(cfg.appSecret, 'receipt', `${handle}.${at}.${nonce}`)).slice(0, 32);

/** A signed note that this browser tapped a button on this mjeshtër's profile at this moment. */
export async function makeReceipt(cfg, handle, now) {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
  return `${handle}.${now.toString(36)}.${nonce}.${await receiptSig(cfg, handle, now, nonce)}`;
}

/**
 * Checks a receipt and how old it is.
 * @returns {Promise<{ handle: string, at: number, nonce: string } | { error: 'invalid' | 'early' | 'late' }>}
 */
export async function readReceipt(cfg, receipt, now) {
  const m = typeof receipt === 'string' && RECEIPT.exec(receipt);
  if (!m) return { error: 'invalid' };
  const [, handle, at36, nonce, sig] = m;
  const at = parseInt(at36, 36);
  if (!Number.isSafeInteger(at) || !safeEqual(sig, await receiptSig(cfg, handle, at, nonce))) return { error: 'invalid' };
  if (at > now + 5 * MINUTE) return { error: 'invalid' };
  if (now - at < REVIEW.minAge) return { error: 'early' };
  if (now - at > REVIEW.maxAge) return { error: 'late' };
  return { handle, at, nonce };
}

// ---------- ratings ----------

/** "4,6": one decimal, Albanian style. */
export const ratingText = (r) => r.toFixed(1).replace('.', ',');   // by hand: the Worker's locale data may lack sq

export const reviewsText = (n) => (n === 1 ? '1 vlerësim' : `${n} vlerësime`);

/** For ranking: the average pulled towards REVIEW.priorMean, so one 5-star review doesn't beat forty 4.8 ones. */
export function rankRating(avg, n) {
  return ((avg || 0) * n + REVIEW.priorMean * REVIEW.priorWeight) / (n + REVIEW.priorWeight);
}

/** The visible reviews of one mjeshtër, newest first, as clients see them. */
export async function publicReviews(cfg, proId) {
  const { results } = await cfg.db.prepare(
    `SELECT stars, comment, author, confirmed_at, reply, replied_at FROM reviews
     WHERE pro_id = ?1 AND status = 'visible' ORDER BY confirmed_at DESC LIMIT ?2`,
  ).bind(proId, REVIEW.publicList).all();
  return results.map((r) => ({
    stars: r.stars, comment: r.comment, author: r.author, at: r.confirmed_at, reply: r.reply, repliedAt: r.replied_at,
  }));
}

/** The average, the count, and how many arrived in the last `days` days, of the visible reviews. */
export async function reviewStats(db, proId, now, days) {
  const row = await db.prepare(
    `SELECT AVG(stars) AS rating, COUNT(*) AS n, SUM(CASE WHEN confirmed_at > ?2 THEN 1 ELSE 0 END) AS fresh
     FROM reviews WHERE pro_id = ?1 AND status = 'visible'`,
  ).bind(proId, now - days * DAY).first();
  return { rating: row.n ? Math.round(row.rating * 10) / 10 : null, reviews: row.n, newReviews: row.fresh || 0 };
}

/** Every confirmed review of a mjeshtër (hidden ones too), for the mjeshtër's panel and the team. */
export async function confirmedReviews(db, proId) {
  const { results } = await db.prepare(
    `SELECT id, stars, comment, author, status, reply, replied_at, reported_at, report_reason, confirmed_at FROM reviews
     WHERE pro_id = ?1 AND status IN ('visible', 'hidden') ORDER BY confirmed_at DESC LIMIT 200`,
  ).bind(proId).all();
  return results.map((r) => ({
    id: r.id, stars: r.stars, comment: r.comment, author: r.author, hidden: r.status === 'hidden', at: r.confirmed_at,
    reply: r.reply, repliedAt: r.replied_at, reported: r.reported_at !== null, reportedAt: r.reported_at, reportReason: r.report_reason,
  }));
}

// ---------- writing one ----------

async function take(cfg, bucket, now, window, max) {
  const res = await cfg.db.prepare(
    'INSERT INTO rate_events (bucket, at) SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM rate_events WHERE bucket = ?1 AND at > ?3) < ?4',
  ).bind(bucket, now, now - window, max).run();
  return Boolean(res.meta && res.meta.changes === 1);
}

/** Cleans and checks the form. Returns { review, errors }. */
export function validateReview(input) {
  const errors = {};
  const stars = Number(input.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) errors.stars = REVIEW_MESSAGES.starsMissing;
  const comment = cleanText(input.comment);
  if (comment.length > REVIEW.comment) errors.comment = REVIEW_MESSAGES.commentTooLong;
  const author = cleanLine(input.author);
  if (author.length > REVIEW.author) errors.author = REVIEW_MESSAGES.authorTooLong;
  const email = normaliseEmail(input.email);
  if (!email) errors.email = REVIEW_MESSAGES.emailMissing;
  else if (!isValidEmail(email)) errors.email = REVIEW_MESSAGES.emailInvalid;
  return { errors, review: { stars, comment, author, email } };
}

/**
 * Stores an unconfirmed review and emails the link that publishes it.
 * @returns {Promise<{ result: 'sent' | 'early' | 'late' | 'invalid' | 'used' | 'gone' | 'rate_limited' }>}
 */
export async function submitReview(cfg, receipt, review, ip, now) {
  const r = await readReceipt(cfg, receipt, now);
  if (r.error) return { result: r.error };
  const db = cfg.db;
  const pro = await db.prepare("SELECT id, name, handle FROM pros WHERE handle = ?1 AND status = 'approved'").bind(r.handle).first();
  if (!pro) return { result: 'gone' };
  const emailHash = await hmac(cfg.appSecret, 'review-email', review.email);
  // One tap, one review: a receipt already used for a confirmed review by another address can't be used again.
  const used = await db.prepare(
    "SELECT 1 FROM reviews WHERE receipt = ?1 AND status IN ('visible', 'hidden') AND email_hash != ?2 LIMIT 1",
  ).bind(r.nonce, emailHash).first();
  if (used) return { result: 'used' };

  const day = Math.floor(now / DAY);
  const who = ip || 'unknown';
  if (!(await take(cfg, await hmac(cfg.appSecret, 'review-ip-hour', who), now, HOUR, REVIEW.perIpHour))
    || !(await take(cfg, await hmac(cfg.appSecret, 'review-ip-day', `${who}|${day}`), now, DAY, REVIEW.perIpDay))
    || !(await take(cfg, await hmac(cfg.appSecret, 'review-email-day', `${emailHash}|${day}`), now, DAY, REVIEW.perEmailDay))) {
    log('review_rate_limited');
    return { result: 'rate_limited' };
  }

  const token = randomToken();
  await db.prepare(
    `INSERT INTO reviews (id, pro_id, receipt, tapped_at, stars, comment, author, email, email_hash, token_hash, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).bind(uuid(), pro.id, r.nonce, r.at, review.stars, review.comment, review.author, review.email, emailHash, await sha256(token), now).run();
  const msg = reviewConfirmEmail({
    siteUrl: cfg.siteUrl, confirmUrl: `${cfg.siteUrl}/vleresimi?t=${token}`, proName: pro.name, stars: review.stars,
    ttlHours: REVIEW.confirmTtl / HOUR,
  });
  await sendEmail(cfg.email, { to: review.email, ...msg });
  log('review_submitted');
  return { result: 'sent' };
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** What the emailed link points at: { review, pro } or null. */
export async function reviewByToken(cfg, token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  return cfg.db.prepare(
    `SELECT r.id, r.pro_id, r.status, r.created_at, r.email_hash, r.receipt, p.name, p.handle, p.status AS pro_status
     FROM reviews r JOIN pros p ON p.id = r.pro_id WHERE r.token_hash = ?1`,
  ).bind(await sha256(token)).first();
}

/**
 * Publishes the review behind the emailed link. The same address's earlier review of this mjeshtër is replaced.
 * @returns {Promise<{ result: 'confirmed' | 'already', path: string | null } | { result: 'expired' | 'invalid' | 'gone' | 'used' }>}
 */
export async function confirmReview(cfg, token, now) {
  const row = await reviewByToken(cfg, token);
  if (!row) return { result: 'invalid' };
  const path = row.pro_status === 'approved' && row.handle ? profilePath(row.name, row.handle) : null;
  if (row.status !== 'unconfirmed') return { result: 'already', path };
  if (now - row.created_at > REVIEW.confirmTtl) return { result: 'expired' };
  if (row.pro_status !== 'approved') return { result: 'gone' };
  const db = cfg.db;
  // One tap, one review: if another address published a review with this receipt meanwhile, that one stays.
  const used = await db.prepare(
    "SELECT 1 FROM reviews WHERE receipt = ?1 AND status IN ('visible', 'hidden') AND email_hash != ?2 LIMIT 1",
  ).bind(row.receipt, row.email_hash).first();
  if (used) return { result: 'used' };
  const [, done] = await db.batch([
    db.prepare("DELETE FROM reviews WHERE pro_id = ?1 AND email_hash = ?2 AND status IN ('visible', 'hidden') AND id != ?3")
      .bind(row.pro_id, row.email_hash, row.id),
    db.prepare("UPDATE reviews SET status = 'visible', email = NULL, confirmed_at = ?2 WHERE id = ?1 AND status = 'unconfirmed'")
      .bind(row.id, now),
  ]);
  if (!done.meta || done.meta.changes !== 1) return { result: 'already', path };
  log('review_confirmed');
  return { result: 'confirmed', path };
}

/** The client deletes their own review through the same emailed link. */
export async function deleteOwnReview(cfg, token) {
  const row = await reviewByToken(cfg, token);
  if (!row) return { result: 'invalid' };
  await cfg.db.prepare('DELETE FROM reviews WHERE id = ?1').bind(row.id).run();
  log('review_deleted_by_author');
  return { result: 'deleted', path: row.pro_status === 'approved' && row.handle ? profilePath(row.name, row.handle) : null };
}

/** Background cleanup: reviews nobody confirmed in time. */
export async function reviewsMaintenance(cfg, now) {
  await cfg.db.prepare("DELETE FROM reviews WHERE status = 'unconfirmed' AND created_at < ?1").bind(now - REVIEW.confirmTtl).run();
}

// ---------- the mjeshtër's answer ----------

/** One public reply per review, by the mjeshtër it is about. */
export async function replyToReview(cfg, proId, id, raw, now) {
  const text = cleanText(raw);
  if (!text) return { result: 'invalid', message: REVIEW_MESSAGES.replyMissing };
  if (text.length > REVIEW.reply) return { result: 'invalid', message: REVIEW_MESSAGES.replyTooLong };
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return { result: 'not_found' };
  const res = await cfg.db.prepare(
    "UPDATE reviews SET reply = ?3, replied_at = ?4 WHERE id = ?1 AND pro_id = ?2 AND status IN ('visible', 'hidden') AND reply = ''",
  ).bind(id, proId, text, now).run();
  if (res.meta && res.meta.changes === 1) { log('review_replied'); return { result: 'ok' }; }
  const row = await cfg.db.prepare("SELECT reply FROM reviews WHERE id = ?1 AND pro_id = ?2 AND status IN ('visible', 'hidden')").bind(id, proId).first();
  return { result: row ? 'already' : 'not_found' };
}

/** The mjeshtër asks the team to look at a review. It stays as it is until the team decides. */
export async function reportReview(cfg, proId, id, raw, now) {
  const reason = cleanText(raw);
  if (reason.length < 3) return { result: 'invalid', message: REVIEW_MESSAGES.reasonMissing };
  if (reason.length > REVIEW.reportReason) return { result: 'invalid', message: REVIEW_MESSAGES.reasonTooLong };
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return { result: 'not_found' };
  const res = await cfg.db.prepare(
    "UPDATE reviews SET reported_at = ?3, report_reason = ?4 WHERE id = ?1 AND pro_id = ?2 AND status = 'visible' AND reported_at IS NULL",
  ).bind(id, proId, now, reason).run();
  if (res.meta && res.meta.changes === 1) { log('review_reported'); return { result: 'ok' }; }
  const row = await cfg.db.prepare("SELECT status, reported_at FROM reviews WHERE id = ?1 AND pro_id = ?2 AND status IN ('visible', 'hidden')").bind(id, proId).first();
  return { result: row ? 'already' : 'not_found' };
}

// ---------- the team's decision ----------

export const REVIEW_ACTIONS = ['keep', 'hide', 'show'];

/**
 * keep: a reported review stays visible and the report is closed. hide: it no longer shows (report closed).
 * show: a hidden review shows again. Returns { result: 'ok' | 'state' | 'not_found' }.
 */
export async function decideReview(cfg, proId, id, action, now) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return { result: 'not_found' };
  const sql = {
    keep: "UPDATE reviews SET reported_at = NULL, report_reason = '' WHERE id = ?1 AND pro_id = ?2 AND status = 'visible' AND reported_at IS NOT NULL",
    hide: "UPDATE reviews SET status = 'hidden', reported_at = NULL, report_reason = '' WHERE id = ?1 AND pro_id = ?2 AND status = 'visible'",
    show: "UPDATE reviews SET status = 'visible' WHERE id = ?1 AND pro_id = ?2 AND status = 'hidden'",
  }[action];
  if (!sql) return { result: 'state' };
  const res = await cfg.db.prepare(sql).bind(id, proId).run();
  if (res.meta && res.meta.changes === 1) { log('review_decision', { action }); return { result: 'ok' }; }
  const row = await cfg.db.prepare("SELECT 1 FROM reviews WHERE id = ?1 AND pro_id = ?2 AND status IN ('visible', 'hidden')").bind(id, proId).first();
  return { result: row ? 'state' : 'not_found' };
}

