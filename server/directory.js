// The public directory (step 4): searching approved mjeshtër by trade and town, their profile pages, and the counts of
// what clients did there (profile views and taps on Thirre, WhatsApp and Viber), per mjeshtër per day.
// Clients have no account and nothing about them is stored: a tap is counted once per day per network address,
// through a keyed hash in rate_events that is deleted after a day.

import { TOWNS, TRADES, TOWN_SLUGS, TRADE_SLUGS, labelOf } from '../src/mjeshtri/catalog.js';
import { hmac } from './crypto.js';
import { HANDLE, profilePath } from './handle.js';
import { MIN_ABOUT, MIN_WORK_PHOTOS, photoUrl, utcDay } from './profile.js';
import { log } from './subscribers.js';

const DAY = 24 * 60 * 60 * 1000;

export const DIRECTORY = {
  perPage: 20,
  maxRows: 1000,           // a search reads at most this many profiles; far above any trade and town for a long while
  tapsPerIpPerDay: 300,    // counted taps and views from one address in a day; past that, nothing more is counted
};

/** The directory is open to everyone only when DIRECTORY_OPEN is "1"; until then only the signed-in team sees it. */
export const directoryOpen = (env) => env.DIRECTORY_OPEN === '1';

export { HANDLE, handleFromSlug, nameSlug, newHandle, profilePath } from './handle.js';

// ---------- reading ----------

const parseList = (json) => { try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; } };

const COLUMNS = `p.id, p.handle, p.phone, p.name, p.about, p.trades, p.towns, p.years, p.price_note, p.whatsapp, p.viber,
  p.available, p.verified, p.approved_at,
  (SELECT id FROM pro_photos WHERE pro_id = p.id AND kind = 'profile' ORDER BY created_at DESC LIMIT 1) AS photo_id,
  (SELECT COUNT(*) FROM pro_photos WHERE pro_id = p.id AND kind = 'work') AS work_count`;

// How complete a profile is, 0–7, the same items as the dashboard's checklist.
function completeness(r, photosOn) {
  return [r.name.length >= 2, r.trades.length > 0, r.towns.length > 0, photosOn && Boolean(r.photoId),
    r.about.length >= MIN_ABOUT, photosOn && r.workCount >= MIN_WORK_PHOTOS, r.years !== null].filter(Boolean).length;
}

function view(r, photosOn) {
  const p = {
    id: r.id,
    handle: r.handle,
    phone: r.phone,
    name: r.name,
    about: r.about,
    trades: parseList(r.trades).filter((s) => TRADE_SLUGS.has(s)),
    towns: parseList(r.towns).filter((s) => TOWN_SLUGS.has(s)),
    years: r.years,
    priceNote: r.price_note,
    whatsapp: r.whatsapp === 1,
    viber: r.viber === 1,
    available: r.available === 1,
    verified: r.verified === 1,
    photoId: r.photo_id,
    workCount: r.work_count,
  };
  p.photo = photosOn && p.photoId ? photoUrl(p.photoId) : null;
  p.path = profilePath(p.name, p.handle);
  p.tradeLabels = p.trades.map((s) => labelOf(TRADES, s));
  p.townLabels = p.towns.map((s) => labelOf(TOWNS, s));
  p.score = completeness(p, photosOn);
  return p;
}

// A number from the handle and the day: among equals, the order changes every day, so nobody stays last for good.
function dailyTurn(handle, day) {
  let h = 2166136261;
  for (const c of `${day}|${handle}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/** Reads ?zanati= and ?komuna= and ?faqja=, keeping only known values. */
export function readSearch(url) {
  const trade = url.searchParams.get('zanati') || '';
  const town = url.searchParams.get('komuna') || '';
  const page = Number(url.searchParams.get('faqja') || '1');
  return {
    trade: TRADE_SLUGS.has(trade) ? trade : '',
    town: TOWN_SLUGS.has(town) ? town : '',
    page: Number.isInteger(page) && page >= 1 && page <= 500 ? page : 1,
  };
}

/**
 * Approved mjeshtër for a trade and a town (either may be empty: all). Ranked by who takes work now, then how
 * complete the profile is, then Verifikuar, then a daily rotation. Stars and reviews join the ranking with step 5.
 * @returns {Promise<{ total: number, page: number, pages: number, results: object[] }>}
 */
export async function search(cfg, { trade, town, page }, now) {
  const { results } = await cfg.db.prepare(
    `SELECT ${COLUMNS} FROM pros p
     WHERE p.status = 'approved' AND p.handle IS NOT NULL
       AND (?1 = '' OR EXISTS (SELECT 1 FROM json_each(p.trades) WHERE value = ?1))
       AND (?2 = '' OR EXISTS (SELECT 1 FROM json_each(p.towns) WHERE value = ?2))
     LIMIT ?3`,
  ).bind(trade, town, DIRECTORY.maxRows).all();
  const photosOn = Boolean(cfg.photos);
  const day = utcDay(now);
  const all = results.map((r) => view(r, photosOn)).map((p) => ({ p, turn: dailyTurn(p.handle, day) }));
  all.sort((a, b) => (b.p.available - a.p.available) || (b.p.score - a.p.score) || (b.p.verified - a.p.verified) || (a.turn - b.turn));
  const pages = Math.max(1, Math.ceil(all.length / DIRECTORY.perPage));
  const at = Math.min(page, pages);
  return {
    total: all.length,
    page: at,
    pages,
    results: all.slice((at - 1) * DIRECTORY.perPage, at * DIRECTORY.perPage).map((x) => x.p),
  };
}

/** An approved mjeshtër's whole public profile by handle, work photos included, or null. */
export async function loadPublicProfile(cfg, handle) {
  if (!HANDLE.test(handle)) return null;
  const row = await cfg.db.prepare(`SELECT ${COLUMNS} FROM pros p WHERE p.handle = ?1 AND p.status = 'approved'`).bind(handle).first();
  if (!row) return null;
  const p = view(row, Boolean(cfg.photos));
  p.work = [];
  if (cfg.photos && p.workCount) {
    const { results } = await cfg.db.prepare(
      "SELECT id, width, height FROM pro_photos WHERE pro_id = ?1 AND kind = 'work' ORDER BY position, created_at",
    ).bind(row.id).all();
    p.work = results.map((w) => ({ url: photoUrl(w.id), width: w.width, height: w.height }));
  }
  return p;
}

/** Every approved profile's address, for the sitemap. */
export async function sitemapEntries(cfg) {
  const { results } = await cfg.db.prepare(
    "SELECT name, handle, MAX(COALESCE(edited_at, 0), COALESCE(approved_at, 0)) AS changed FROM pros WHERE status = 'approved' AND handle IS NOT NULL ORDER BY approved_at LIMIT 45000",
  ).all();
  return results.map((r) => ({ path: profilePath(r.name, r.handle), changed: r.changed || null }));
}

// ---------- counting ----------

// The API's names for what was tapped, and the column each one adds to.
export const TAPS = { shikim: 'views', thirrje: 'calls', whatsapp: 'whatsapp', viber: 'viber' };

/**
 * Counts a profile view or a tap for the mjeshtër with this handle, at most once per kind per day per network
 * address, and at most DIRECTORY.tapsPerIpPerDay from one address. Only approved profiles count.
 * @returns {Promise<boolean>} whether it was counted
 */
export async function countTap(cfg, handle, kind, ip, now) {
  const column = TAPS[kind];
  if (!column || !HANDLE.test(handle)) return false;
  const day = utcDay(now);
  const who = ip || 'unknown';
  const [once, perIp] = await Promise.all([
    hmac(cfg.appSecret, 'tap', `${handle}|${kind}|${who}|${day}`),
    hmac(cfg.appSecret, 'tap-ip', `${who}|${day}`),
  ]);
  // One statement: the first of two identical taps wins, and the address's cap holds under parallel requests.
  const res = await cfg.db.prepare(
    `INSERT INTO rate_events (bucket, at) SELECT b, ?3 FROM (SELECT ?1 AS b UNION ALL SELECT ?2 AS b)
     WHERE NOT EXISTS (SELECT 1 FROM rate_events WHERE bucket = ?1 AND at > ?4)
       AND (SELECT COUNT(*) FROM rate_events WHERE bucket = ?2 AND at > ?4) < ?5
       AND EXISTS (SELECT 1 FROM pros WHERE handle = ?6 AND status = 'approved')`,
  ).bind(once, perIp, now, now - DAY, DIRECTORY.tapsPerIpPerDay, handle).run();
  if (!res.meta || res.meta.changes !== 2) return false;
  await cfg.db.prepare(
    `INSERT INTO pro_stats_daily (pro_id, day, ${column}) SELECT id, ?2, 1 FROM pros WHERE handle = ?1 AND status = 'approved'
     ON CONFLICT (pro_id, day) DO UPDATE SET ${column} = ${column} + 1`,
  ).bind(handle, day).run();
  log('tap_counted', { kind });
  return true;
}
