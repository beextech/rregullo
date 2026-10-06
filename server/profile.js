// The mjeshtër dashboard: the profile, its completeness, sending it for approval, the "taking work now" switch,
// the Ballina counts, and deleting the account. Every query is a prepared statement with bound parameters,
// always scoped to the signed-in mjeshtër's id.

import { LIMITS, TOWN_SLUGS, TRADE_SLUGS } from '../src/mjeshtri/catalog.js';
import { formatPhone } from './signin.js';
import { log } from './subscribers.js';

const DAY = 24 * 60 * 60 * 1000;
export const STATS_DAYS = 30;

export const PROFILE_MESSAGES = {
  nameMissing: 'Shkruaje emrin që do ta shohin klientët.',
  nameTooLong: `Emri mund të ketë deri në ${LIMITS.name} shkronja.`,
  nameChars: 'Emri mund të ketë vetëm shkronja, numra, hapësira dhe shenjat . - \' &',
  aboutTooLong: `Përshkrimi mund të ketë deri në ${LIMITS.about} shkronja.`,
  tradesTooMany: `Zgjidh deri në ${LIMITS.maxTrades} zanate.`,
  townsTooMany: `Zgjidh deri në ${LIMITS.maxTowns} komuna.`,
  yearsInvalid: `Shkruaji vitet e përvojës me numër, nga 0 deri në ${LIMITS.maxYears}.`,
  priceTooLong: `Çmimi mund të ketë deri në ${LIMITS.priceNote} shkronja.`,
  invalid: 'Disa të dhëna nuk janë në rregull. Kontrolloji fushat e shënuara.',
  saved: 'U ruajt.',
  suspended: 'Llogaria jote është pezulluar, prandaj profili nuk mund të ndryshohet. Na shkruaj nëse mendon se është gabim.',
  incomplete: 'Plotësoji pikat e shënuara para se ta dërgosh.',
  submitted: 'Profili u dërgua për shqyrtim. Të njoftojmë kur të aprovohet.',
  alreadyPending: 'Profili yt është duke u shqyrtuar.',
  alreadyApproved: 'Profili yt është aprovuar tashmë.',
};

// What a profile needs before it can be sent for approval, and what makes it stronger. Shown on the Ballina in this order.
export const CHECKLIST = [
  { key: 'name', required: true },
  { key: 'trades', required: true },
  { key: 'towns', required: true },
  { key: 'photo', required: true },
  { key: 'about', required: false },
  { key: 'work', required: false },
  { key: 'years', required: false },
];
export const MIN_ABOUT = 40;        // characters, for the "about" item to count as done
export const MIN_WORK_PHOTOS = 3;

// ---------- cleaning and validation ----------

// Control characters, format characters (zero-width, bidi overrides, soft hyphen) and line/paragraph separators.
const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
const NAME_CHARS = /^[\p{L}\p{M}\p{N} .'’&-]+$/u;

/** One line of text: NFC, no control or invisible characters, single spaces, trimmed. */
export function cleanLine(raw) {
  return String(raw ?? '').normalize('NFC').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
}

/** Free text with paragraphs: like cleanLine per line, at most one empty line between paragraphs. */
export function cleanText(raw) {
  return String(raw ?? '').normalize('NFC').replace(/\r\n?/g, '\n')
    .split('\n').map((line) => line.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function slugList(raw, allowed) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const s of raw) {
    if (typeof s !== 'string' || !allowed.has(s)) return null;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';

/**
 * Checks a profile sent by the dashboard. Every field is optional while saving a draft; what is needed to
 * send it for approval is decided by the checklist. Returns { profile, errors } (errors maps field → message).
 */
export function validateProfile(input) {
  const errors = {};
  const name = cleanLine(input.name);
  if (name.length > LIMITS.name) errors.name = PROFILE_MESSAGES.nameTooLong;
  else if (name && !NAME_CHARS.test(name)) errors.name = PROFILE_MESSAGES.nameChars;

  const about = cleanText(input.about);
  if (about.length > LIMITS.about) errors.about = PROFILE_MESSAGES.aboutTooLong;

  const trades = slugList(input.trades ?? [], TRADE_SLUGS);
  if (!trades) errors.trades = PROFILE_MESSAGES.invalid;
  else if (trades.length > LIMITS.maxTrades) errors.trades = PROFILE_MESSAGES.tradesTooMany;

  const towns = slugList(input.towns ?? [], TOWN_SLUGS);
  if (!towns) errors.towns = PROFILE_MESSAGES.invalid;
  else if (towns.length > LIMITS.maxTowns) errors.towns = PROFILE_MESSAGES.townsTooMany;

  let years = null;
  const rawYears = typeof input.years === 'string' ? input.years.trim() : input.years;
  if (rawYears !== null && rawYears !== undefined && rawYears !== '') {
    const n = typeof rawYears === 'number' ? rawYears : (/^\d{1,3}$/.test(rawYears) ? Number(rawYears) : NaN);
    if (!Number.isInteger(n) || n < 0 || n > LIMITS.maxYears) errors.years = PROFILE_MESSAGES.yearsInvalid;
    else years = n;
  }

  const priceNote = cleanLine(input.priceNote);
  if (priceNote.length > LIMITS.priceNote) errors.priceNote = PROFILE_MESSAGES.priceTooLong;

  return {
    errors,
    profile: { name, about, trades: trades || [], towns: towns || [], years, priceNote, whatsapp: bool(input.whatsapp), viber: bool(input.viber) },
  };
}

// ---------- reading ----------

const parseList = (json) => { try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; } };

export const photoUrl = (id) => `/foto/${id}.jpg`;

function checklist(p, photos) {
  const done = {
    name: p.name.length >= 2,
    trades: p.trades.length > 0,
    towns: p.towns.length > 0,
    photo: Boolean(photos.profile),
    about: p.about.length >= MIN_ABOUT,
    work: photos.work.length >= MIN_WORK_PHOTOS,
    years: p.years !== null,
  };
  const items = CHECKLIST.map((c) => ({ ...c, done: done[c.key] }));
  return {
    items,
    ready: items.every((i) => !i.required || i.done),
    percent: Math.round((100 * items.filter((i) => i.done).length) / items.length),
  };
}

async function loadPhotos(db, proId) {
  const { results } = await db.prepare(
    'SELECT id, kind, width, height FROM pro_photos WHERE pro_id = ?1 ORDER BY kind, position, created_at',
  ).bind(proId).all();
  const view = (r) => ({ id: r.id, url: photoUrl(r.id), width: r.width, height: r.height });
  const profile = results.find((r) => r.kind === 'profile');
  return { profile: profile ? view(profile) : null, work: results.filter((r) => r.kind === 'work').map(view) };
}

export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

async function loadStats(db, proId, now) {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(views), 0) AS views, COALESCE(SUM(calls), 0) AS calls,
            COALESCE(SUM(whatsapp), 0) AS whatsapp, COALESCE(SUM(viber), 0) AS viber
     FROM pro_stats_daily WHERE pro_id = ?1 AND day > ?2`,
  ).bind(proId, utcDay(now - STATS_DAYS * DAY)).first();
  // Reviews arrive with step 5; until then there are none.
  return { days: STATS_DAYS, views: row.views, calls: row.calls, whatsapp: row.whatsapp, viber: row.viber, rating: null, reviews: 0, newReviews: 0 };
}

/** Everything the dashboard shows, in one answer. */
export async function loadDashboard(cfg, proId, now) {
  const db = cfg.db;
  const row = await db.prepare(
    `SELECT phone, name, about, trades, towns, years, price_note, whatsapp, viber, available, status, status_note,
            verified, submitted_at FROM pros WHERE id = ?1`,
  ).bind(proId).first();
  if (!row) return null;
  const profile = {
    name: row.name, about: row.about, trades: parseList(row.trades), towns: parseList(row.towns), years: row.years,
    priceNote: row.price_note, whatsapp: row.whatsapp === 1, viber: row.viber === 1,
  };
  const [photos, stats] = await Promise.all([loadPhotos(db, proId), loadStats(db, proId, now)]);
  return {
    phone: formatPhone(row.phone),
    profile,
    available: row.available === 1,
    status: row.status,
    statusNote: row.status_note,
    verified: row.verified === 1,
    submittedAt: row.submitted_at,
    photos,
    photosEnabled: Boolean(cfg.photos),
    stats,
    checklist: checklist(profile, photos),
  };
}

// ---------- changing ----------

export async function saveProfile(cfg, proId, profile, now) {
  await cfg.db.prepare(
    `UPDATE pros SET name = ?2, about = ?3, trades = ?4, towns = ?5, years = ?6, price_note = ?7, whatsapp = ?8, viber = ?9,
       updated_at = ?10 WHERE id = ?1`,
  ).bind(proId, profile.name, profile.about, JSON.stringify(profile.trades), JSON.stringify(profile.towns), profile.years,
    profile.priceNote, profile.whatsapp ? 1 : 0, profile.viber ? 1 : 0, now).run();
  log('profile_saved');
}

export async function setAvailable(cfg, proId, available, now) {
  await cfg.db.prepare('UPDATE pros SET available = ?2, updated_at = ?3 WHERE id = ?1').bind(proId, available ? 1 : 0, now).run();
}

/**
 * Sends the profile to the team for approval (from draft, or again after a rejection).
 * @returns {{ result: 'submitted' | 'pending' | 'approved' | 'suspended' | 'incomplete', missing?: string[] }}
 */
export async function submitProfile(cfg, proId, now) {
  const dash = await loadDashboard(cfg, proId, now);
  if (!dash) return { result: 'incomplete', missing: [] };
  if (dash.status === 'suspended') return { result: 'suspended' };
  if (dash.status === 'pending') return { result: 'pending' };
  if (dash.status === 'approved') return { result: 'approved' };
  if (!dash.checklist.ready) {
    return { result: 'incomplete', missing: dash.checklist.items.filter((i) => i.required && !i.done).map((i) => i.key) };
  }
  const res = await cfg.db.prepare(
    `UPDATE pros SET status = 'pending', status_note = '', submitted_at = ?2, updated_at = ?2
     WHERE id = ?1 AND status IN ('draft', 'rejected')`,
  ).bind(proId, now).run();
  if (!res.meta || res.meta.changes !== 1) return { result: 'pending' };
  log('profile_submitted');
  return { result: 'submitted' };
}

/** Signs the mjeshtër out on every phone and browser. */
export async function endAllSessions(cfg, proId) {
  await cfg.db.prepare("DELETE FROM sessions WHERE kind = 'pro' AND subject = ?1").bind(proId).run();
  log('signout_everywhere');
}

/**
 * Deletes the account and everything that belongs to it: photos (in R2 first, so none is left behind if that fails),
 * counts, sessions and the profile. The sign-in code record for the number expires on its own within a day.
 */
export async function deleteAccount(cfg, proId) {
  const db = cfg.db;
  const { results } = await db.prepare('SELECT id FROM pro_photos WHERE pro_id = ?1').bind(proId).all();
  if (results.length) {
    if (!cfg.photos) throw new Error('photo storage not configured');
    await cfg.photos.delete(results.map((r) => `foto/${r.id}.jpg`));
  }
  await db.batch([
    db.prepare('DELETE FROM pro_photos WHERE pro_id = ?1').bind(proId),
    db.prepare('DELETE FROM pro_stats_daily WHERE pro_id = ?1').bind(proId),
    db.prepare("DELETE FROM sessions WHERE kind = 'pro' AND subject = ?1").bind(proId),
    db.prepare('DELETE FROM pros WHERE id = ?1').bind(proId),
  ]);
  log('account_deleted');
}
