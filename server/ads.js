// Ads (step 6): companies that sell repair products advertise in the search results, on profiles, in the mini games
// and as offers on the mjeshtër's Ballina, always marked "Sponsorizuar". A campaign shows only on its trades and
// towns, between its dates, while switched on. Views and clicks are counted here on our own server (no third party),
// once per network address per day, and the team downloads a monthly report per advertiser.

import { TOWN_SLUGS, TRADE_SLUGS } from '../src/mjeshtri/catalog.js';
import { hmac, uuid } from './crypto.js';
import { jpegInfo, stripMetadata } from './jpeg.js';
import { cleanLine, photoUrl, utcDay } from './profile.js';
import { log } from './subscribers.js';

const DAY = 24 * 60 * 60 * 1000;

export const ADS = {
  slots: ['kerko', 'profili', 'loja', 'paneli'],
  name: 80,
  contact: 200,
  title: 90,
  link: 500,
  countsPerIpPerDay: 300,   // ad views and clicks counted from one address in a day
  imageMinEdge: 200,
  imageMaxEdge: 4000,
};

export const SLOT_NAMES = { kerko: 'Kërkimi', profili: 'Profilet', loja: 'Lojërat', paneli: 'Paneli i mjeshtrit' };

export const AD_MESSAGES = {
  nameMissing: 'Shkruaje emrin e kompanisë.',
  nameTooLong: `Emri mund të ketë deri në ${ADS.name} shkronja.`,
  contactTooLong: `Kontakti mund të ketë deri në ${ADS.contact} shkronja.`,
  titleMissing: 'Shkruaje tekstin e reklamës.',
  titleTooLong: `Teksti mund të ketë deri në ${ADS.title} shkronja.`,
  linkInvalid: 'Shkruaje adresën e plotë, që fillon me https://',
  slotsMissing: 'Zgjidh të paktën një vend ku shfaqet.',
  datesInvalid: 'Shkruaji datat si VVVV-MM-DD, dhe e fundit të mos jetë para të parës.',
  invalid: 'Disa fusha nuk janë në rregull.',
  advertiserNotFound: 'Ky reklamues nuk u gjet. Mund të jetë fshirë.',
  campaignNotFound: 'Kjo reklamë nuk u gjet. Mund të jetë fshirë.',
  advertiserSaved: 'Reklamuesi u ruajt.',
  campaignSaved: 'Reklama u ruajt.',
  imageSaved: 'Fotoja e reklamës u ruajt.',
  imageRemoved: 'Fotoja e reklamës u hoq.',
  imageInvalid: `Kjo foto nuk u lexua. Përdor një JPEG, të paktën ${ADS.imageMinEdge} piksel në anën e shkurtër.`,
  campaignDeleted: 'Reklama u fshi bashkë me numrat e saj.',
  advertiserDeleted: 'Reklamuesi u fshi bashkë me reklamat dhe numrat e tyre.',
  confirm: 'Shkruaj FSHIJE për ta konfirmuar.',
  monthInvalid: 'Zgjidh muajin si VVVV-MM.',
};

const parseList = (json) => { try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; } };
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const realDate = (s) => typeof s === 'string' && DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export const validId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);

/** A link an ad may point at: https only, no user:password, no spaces. */
export function cleanLink(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > ADS.link || /\s/.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
    return u.href;
  } catch {
    return null;
  }
}

// ---------- the team: advertisers and campaigns ----------

export function validateAdvertiser(input) {
  const errors = {};
  const name = cleanLine(input.name);
  if (!name) errors.name = AD_MESSAGES.nameMissing;
  else if (name.length > ADS.name) errors.name = AD_MESSAGES.nameTooLong;
  const contact = cleanLine(input.contact);
  if (contact.length > ADS.contact) errors.contact = AD_MESSAGES.contactTooLong;
  return { errors, advertiser: { name, contact } };
}

const pick = (list, allowed) => (Array.isArray(list) ? [...new Set(list.filter((x) => typeof x === 'string' && allowed.has(x)))] : []);

export function validateCampaign(input) {
  const errors = {};
  const title = cleanLine(input.title);
  if (!title) errors.title = AD_MESSAGES.titleMissing;
  else if (title.length > ADS.title) errors.title = AD_MESSAGES.titleTooLong;
  const link = cleanLink(input.link);
  if (!link) errors.link = AD_MESSAGES.linkInvalid;
  const slots = pick(input.slots, new Set(ADS.slots));
  if (!slots.length) errors.slots = AD_MESSAGES.slotsMissing;
  const trades = pick(input.trades, TRADE_SLUGS);
  const towns = pick(input.towns, TOWN_SLUGS);
  const startsOn = input.startsOn;
  const endsOn = input.endsOn;
  if (!realDate(startsOn) || !realDate(endsOn) || endsOn < startsOn) errors.dates = AD_MESSAGES.datesInvalid;
  return { errors, campaign: { title, link, slots, trades, towns, startsOn, endsOn, active: input.active !== false } };
}

/** Creates (no id) or changes an advertiser. Returns the id, or null when the id is unknown. */
export async function saveAdvertiser(cfg, id, a, now) {
  if (id) {
    const res = await cfg.db.prepare('UPDATE advertisers SET name = ?2, contact = ?3, updated_at = ?4 WHERE id = ?1')
      .bind(id, a.name, a.contact, now).run();
    return res.meta && res.meta.changes === 1 ? id : null;
  }
  const newId = uuid();
  await cfg.db.prepare('INSERT INTO advertisers (id, name, contact, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)')
    .bind(newId, a.name, a.contact, now).run();
  return newId;
}

/** Creates (no id, under advertiserId) or changes a campaign. Returns the id, or null when either id is unknown. */
export async function saveCampaign(cfg, id, advertiserId, c, now) {
  const db = cfg.db;
  const values = [c.title, c.link, JSON.stringify(c.trades), JSON.stringify(c.towns), JSON.stringify(c.slots), c.startsOn, c.endsOn, c.active ? 1 : 0, now];
  if (id) {
    const res = await db.prepare(
      `UPDATE campaigns SET title = ?2, link = ?3, trades = ?4, towns = ?5, slots = ?6, starts_on = ?7, ends_on = ?8,
         active = ?9, updated_at = ?10 WHERE id = ?1`,
    ).bind(id, ...values).run();
    return res.meta && res.meta.changes === 1 ? id : null;
  }
  if (!validId(advertiserId)) return null;
  const newId = uuid();
  const res = await db.prepare(
    `INSERT INTO campaigns (id, advertiser_id, title, link, trades, towns, slots, starts_on, ends_on, active, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11 WHERE EXISTS (SELECT 1 FROM advertisers WHERE id = ?2)`,
  ).bind(newId, advertiserId, ...values).run();
  return res.meta && res.meta.changes === 1 ? newId : null;
}

/** Sets the campaign's image (a JPEG, stored without its metadata). The old one is removed. */
export async function saveCampaignImage(cfg, id, upload) {
  const row = await cfg.db.prepare('SELECT image_id FROM campaigns WHERE id = ?1').bind(id).first();
  if (!row) return { result: 'not_found' };
  const info = jpegInfo(upload);
  const bytes = info && stripMetadata(upload);
  if (!info || !bytes || Math.min(info.width, info.height) < ADS.imageMinEdge || Math.max(info.width, info.height) > ADS.imageMaxEdge) {
    return { result: 'invalid' };
  }
  const imageId = uuid();
  await cfg.photos.put(`foto/${imageId}.jpg`, bytes, { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: { kind: 'ad' } });
  await cfg.db.prepare('UPDATE campaigns SET image_id = ?2 WHERE id = ?1').bind(id, imageId).run();
  if (row.image_id) await cfg.photos.delete(`foto/${row.image_id}.jpg`).catch((e) => log('photo_cleanup_failed', { reason: e.message }));
  return { result: 'ok' };
}

export async function removeCampaignImage(cfg, id) {
  const row = await cfg.db.prepare('SELECT image_id FROM campaigns WHERE id = ?1').bind(id).first();
  if (!row) return { result: 'not_found' };
  await cfg.db.prepare('UPDATE campaigns SET image_id = NULL WHERE id = ?1').bind(id).run();
  if (row.image_id && cfg.photos) await cfg.photos.delete(`foto/${row.image_id}.jpg`).catch((e) => log('photo_cleanup_failed', { reason: e.message }));
  return { result: 'ok' };
}

/** Deletes campaigns (by id, or all of one advertiser's) with their counts and images. */
async function dropImages(cfg, rows) {
  const keys = rows.filter((r) => r.image_id).map((r) => `foto/${r.image_id}.jpg`);
  if (keys.length && cfg.photos) await cfg.photos.delete(keys).catch((e) => log('photo_cleanup_failed', { reason: e.message }));
}

export async function deleteCampaign(cfg, id) {
  const { results } = await cfg.db.prepare('DELETE FROM campaigns WHERE id = ?1 RETURNING image_id').bind(id).all();
  if (!results.length) return false;
  await dropImages(cfg, results);
  return true;
}

export async function deleteAdvertiser(cfg, id) {
  const db = cfg.db;
  const [camps, adv] = await db.batch([
    db.prepare('DELETE FROM campaigns WHERE advertiser_id = ?1 RETURNING image_id').bind(id),
    db.prepare('DELETE FROM advertisers WHERE id = ?1 RETURNING id').bind(id),
  ]);
  await dropImages(cfg, camps.results || []);
  return (adv.results || []).length === 1;
}

/** What a campaign is doing today. */
export function campaignState(c, today) {
  if (!c.active) return 'off';
  if (today < c.startsOn) return 'scheduled';
  if (today > c.endsOn) return 'ended';
  return 'live';
}

function campaignView(r, today) {
  const c = {
    id: r.id,
    advertiserId: r.advertiser_id,
    title: r.title,
    link: r.link,
    image: r.image_id ? photoUrl(r.image_id) : null,
    trades: parseList(r.trades),
    towns: parseList(r.towns),
    slots: parseList(r.slots),
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    active: r.active === 1,
    views30: r.views30 || 0,
    clicks30: r.clicks30 || 0,
    updatedAt: r.updated_at,
  };
  c.state = campaignState(c, today);
  return c;
}

/** Everything the team's ads page shows: advertisers, their campaigns, and the last 30 days' counts. */
export async function listAds(cfg, now) {
  const db = cfg.db;
  const since = utcDay(now - 29 * DAY);
  const [advs, camps] = await Promise.all([
    db.prepare('SELECT id, name, contact, created_at FROM advertisers ORDER BY name COLLATE NOCASE, created_at').all(),
    db.prepare(
      `SELECT c.*, (SELECT SUM(views) FROM ad_stats_daily s WHERE s.campaign_id = c.id AND s.day >= ?1) AS views30,
              (SELECT SUM(clicks) FROM ad_stats_daily s WHERE s.campaign_id = c.id AND s.day >= ?1) AS clicks30
       FROM campaigns c ORDER BY c.starts_on DESC, c.created_at DESC`,
    ).bind(since).all(),
  ]);
  const today = utcDay(now);
  const byAdv = new Map(advs.results.map((a) => [a.id, { id: a.id, name: a.name, contact: a.contact, campaigns: [] }]));
  for (const r of camps.results) {
    const a = byAdv.get(r.advertiser_id);
    if (a) a.campaigns.push(campaignView(r, today));
  }
  return { today, advertisers: [...byAdv.values()] };
}

export async function loadCampaign(cfg, id, now) {
  if (!validId(id)) return null;
  const r = await cfg.db.prepare('SELECT * FROM campaigns WHERE id = ?1').bind(id).first();
  return r ? campaignView(r, utcDay(now)) : null;
}

// ---------- the monthly report ----------

const csvCell = (v) => {
  const s = String(v ?? '');
  // A leading = + - @ would be read as a formula by spreadsheet apps.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * One advertiser's month as CSV: a row per campaign, slot and day, with a total per campaign.
 * @returns {Promise<{ name: string, csv: string } | null>}
 */
export async function monthlyReport(cfg, advertiserId, month) {
  if (!validId(advertiserId) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) return null;
  const db = cfg.db;
  const adv = await db.prepare('SELECT name FROM advertisers WHERE id = ?1').bind(advertiserId).first();
  if (!adv) return null;
  const { results } = await db.prepare(
    `SELECT c.title, c.id, s.day, s.slot, s.views, s.clicks FROM ad_stats_daily s JOIN campaigns c ON c.id = s.campaign_id
     WHERE c.advertiser_id = ?1 AND s.day LIKE ?2 ORDER BY c.title COLLATE NOCASE, c.id, s.day, s.slot`,
  ).bind(advertiserId, `${month}-%`).all();
  const rows = [['Reklama', 'Dita', 'Vendi', 'Shikime', 'Klikime']];
  const totals = new Map();
  for (const r of results) {
    rows.push([r.title, r.day, SLOT_NAMES[r.slot] || r.slot, r.views, r.clicks]);
    const t = totals.get(r.id) || { title: r.title, views: 0, clicks: 0 };
    t.views += r.views;
    t.clicks += r.clicks;
    totals.set(r.id, t);
  }
  rows.push([]);
  for (const t of totals.values()) rows.push([`Gjithsej: ${t.title}`, month, '', t.views, t.clicks]);
  if (!totals.size) rows.push(['Asnjë shikim këtë muaj', month, '', 0, 0]);
  // The BOM lets Excel open the file as UTF-8, so ë and ç stay readable.
  return { name: adv.name, csv: `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n` };
}

// ---------- showing an ad ----------

const matches = (targets, have) => targets.length === 0 || have.some((x) => targets.includes(x));

/**
 * The ad for one slot: a live campaign whose trades and towns fit what the page is about (a campaign for some trades
 * or towns only shows where those are known). One at random when several fit, so each gets its share.
 * @param {{ trades?: string[], towns?: string[] }} context
 */
export async function pickAd(cfg, slot, context, now) {
  if (!ADS.slots.includes(slot)) return null;
  const today = utcDay(now);
  const { results } = await cfg.db.prepare(
    `SELECT c.id, c.title, c.link, c.image_id, c.trades, c.towns, c.slots, a.name AS advertiser
     FROM campaigns c JOIN advertisers a ON a.id = c.advertiser_id
     WHERE c.active = 1 AND c.starts_on <= ?1 AND c.ends_on >= ?1`,
  ).bind(today).all();
  const trades = (context.trades || []).filter(Boolean);
  const towns = (context.towns || []).filter(Boolean);
  const fit = results.filter((r) => parseList(r.slots).includes(slot)
    && matches(parseList(r.trades), trades) && matches(parseList(r.towns), towns));
  if (!fit.length) return null;
  const r = fit[Math.floor(Math.random() * fit.length)];
  return {
    id: r.id,
    slot,
    title: r.title,
    advertiser: r.advertiser,
    image: r.image_id ? photoUrl(r.image_id) : null,
    href: `/r/${r.id}?v=${slot}`,
  };
}

/** Counts a view or a click of a live ad, once per ad, slot, kind and network address per day. */
export async function countAd(cfg, id, slot, kind, ip, now) {
  if (!validId(id) || !ADS.slots.includes(slot) || (kind !== 'views' && kind !== 'clicks')) return false;
  const day = utcDay(now);
  const who = ip || 'unknown';
  const [once, perIp] = await Promise.all([
    hmac(cfg.appSecret, 'ad', `${id}|${slot}|${kind}|${who}|${day}`),
    hmac(cfg.appSecret, 'ad-ip', `${who}|${day}`),
  ]);
  const res = await cfg.db.prepare(
    `INSERT INTO rate_events (bucket, at) SELECT b, ?3 FROM (SELECT ?1 AS b UNION ALL SELECT ?2 AS b)
     WHERE NOT EXISTS (SELECT 1 FROM rate_events WHERE bucket = ?1 AND at > ?4)
       AND (SELECT COUNT(*) FROM rate_events WHERE bucket = ?2 AND at > ?4) < ?5
       AND EXISTS (SELECT 1 FROM campaigns WHERE id = ?6 AND active = 1 AND starts_on <= ?7 AND ends_on >= ?7)`,
  ).bind(once, perIp, now, now - DAY, ADS.countsPerIpPerDay, id, day).run();
  if (!res.meta || res.meta.changes !== 2) return false;
  await cfg.db.prepare(
    `INSERT INTO ad_stats_daily (campaign_id, day, slot, ${kind}) VALUES (?1, ?2, ?3, 1)
     ON CONFLICT (campaign_id, day, slot) DO UPDATE SET ${kind} = ${kind} + 1`,
  ).bind(id, day, slot).run();
  return true;
}

/** Where a click goes: the campaign's link, or null for an unknown id. */
export async function adLink(cfg, id) {
  if (!validId(id)) return null;
  const r = await cfg.db.prepare('SELECT link FROM campaigns WHERE id = ?1').bind(id).first();
  return r ? r.link : null;
}
