// The team admin (/admin): sign-in by email (a link or the 6-digit code in it), only for the addresses in
// ADMIN_EMAILS; the approval queue and the decisions on a profile; adding a mjeshtër; the history of who did what.
// Every query is a prepared statement with bound parameters. Logs carry event names only: no addresses, numbers,
// tokens or codes.

import { readConfig } from './config.js';
import { hmac, randomToken, safeEqual, sha256, uuid } from './crypto.js';
import { sendEmail } from './email.js';
import { newHandle, profilePath } from './handle.js';
import { cleanText, loadDashboard } from './profile.js';
import { MESSAGES, formatPhone, missingCoreConfig, readAppConfig, readCookie } from './signin.js';
import { sendSms, smsConfigured } from './sms.js';
import { log } from './subscribers.js';
import { adminLinkEmail, adminQueueEmail } from './templates.js';
import { isValidEmail, normaliseEmail } from './validate.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const ADMIN = {
  linkTtl: 15 * MINUTE,          // a sign-in link (and its code) works for 15 minutes, once
  linksPerEmail: 3,              // links sent to one address per 15 minutes
  ipPerTenMinutes: 5,            // link requests per network (IP)
  ipPerDay: 20,
  codeAttempts: 5,               // tries on one link's code
  codeTriesPerDay: 20,           // code tries per address per 24 hours, whatever the link (the link itself still works)
  sessionTtl: 7 * DAY,
  keepLinks: DAY,                // link records are deleted a day after they were made
  smsPerPro: 3,                  // approve/reject texts per mjeshtër per 24 hours
  smsPerDay: 50,                 // and in all per 24 hours
  addsPerDay: 20,                // mjeshtër added by one team member per 24 hours
  listMax: 200,
  searchMax: 60,                 // characters
  noteMin: 3,
  noteMax: 300,
  logRows: 100,
};

export const ADMIN_COOKIE = 'rr_ekipi';

export const ADMIN_MESSAGES = {
  emailInvalid: 'Shkruaje një adresë emaili të vlefshme.',
  linkSent: 'Nëse kjo adresë ka qasje, të dërguam një email me lidhje dhe kod. Vlejnë 15 minuta.',
  tooMany: 'Ke kërkuar shumë lidhje. Provo prapë pas pak.',
  linkExpired: 'Kjo lidhje nuk vlen më. Kërko një të re.',
  codeInvalid: 'Kodi nuk është i saktë.',
  signedOut: 'Nuk je i kyçur. Hyr prapë me emailin e ekipit.',
  notFound: 'Ky mjeshtër nuk u gjet. Mund të jetë fshirë.',
  statusInvalid: 'Ky filtër nuk njihet.',
  actionInvalid: 'Ky veprim nuk njihet.',
  noteInvalid: `Shkruaje arsyen, nga ${ADMIN.noteMin} deri në ${ADMIN.noteMax} shkronja.`,
  internalNoteTooLong: `Shënimi për ekipin mund të ketë deri në ${ADMIN.noteMax} shkronja.`,
  incomplete: 'Profilit i mungojnë pikat e shënuara, prandaj nuk mund të aprovohet.',
  notNow: 'Ky veprim nuk vlen për gjendjen e tanishme të profilit. Shikoje prapë.',
  editedMeanwhile: 'Mjeshtri e ndryshoi profilin ndërkohë. Shikoje prapë.',
  approved: 'Profili u aprovua.',
  rejected: 'Profili u kthye për ndryshime.',
  suspended: 'Llogaria u pezullua.',
  unsuspendedPending: 'Pezullimi u hoq. Profili është në pritje të shqyrtimit.',
  unsuspendedDraft: 'Pezullimi u hoq. Profili është pa dërguar, sepse i mungojnë disa pika.',
  verified: 'U shënua si i verifikuar.',
  unverified: 'Shenja Verifikuar u hoq.',
  seen: 'Ndryshimet u shënuan si të kontrolluara.',
  consentMissing: 'Shtoje vetëm me pëlqimin e mjeshtrit. Konfirmo që e ke.',
  exists: 'Ky numër është tashmë në Rregullo.',
  created: 'Mjeshtri u shtua. Plotësoje profilin dhe aprovoje.',
  addsTooMany: 'Ke shtuar shumë mjeshtër sot. Provo prapë nesër.',
  deleted: 'Llogaria e mjeshtrit u fshi bashkë me profilin dhe fotot.',
  deletedSuspended: 'Profili dhe fotot u fshinë. Numri mbetet i pezulluar.',
};

// ---------- settings ----------

/** ADMIN_EMAILS: addresses separated by commas, spaces or new lines. Compared trimmed and lowercased. */
export function parseAdminEmails(raw) {
  return new Set(String(raw || '').split(/[\s,;]+/).map(normaliseEmail).filter((e) => e && isValidEmail(e)));
}

export function readAdminConfig(env) {
  return { ...readAppConfig(env), adminEmails: parseAdminEmails(env.ADMIN_EMAILS), email: readConfig(env).email };
}

/** What the team panel needs: the database, the site address and the secret; to send links, the email settings too. */
export function missingAdminConfig(cfg, { email = false } = {}) {
  const missing = missingCoreConfig(cfg);
  if (email && !cfg.email.apiKey) missing.push('RESEND_API_KEY');
  if (email && !cfg.email.from) missing.push('EMAIL_FROM');
  return missing;
}

// ---------- limits ----------

/**
 * Counts one event in `bucket` unless it already has `max` within `window` (and `max2` within `window2`), in one
 * statement, so requests at the same moment can't pass the cap. True when it was counted (still under the cap).
 */
async function take(cfg, bucket, now, window, max, window2 = window, max2 = max) {
  const res = await cfg.db.prepare(
    `INSERT INTO rate_events (bucket, at) SELECT ?1, ?2
     WHERE (SELECT COUNT(*) FROM rate_events WHERE bucket = ?1 AND at > ?3) < ?4
       AND (SELECT COUNT(*) FROM rate_events WHERE bucket = ?1 AND at > ?5) < ?6`,
  ).bind(bucket, now, now - window, max, now - window2, max2).run();
  return Boolean(res.meta && res.meta.changes === 1);
}

/** True when this network may ask for another link (and counts it). The only limit that answers differently. */
export async function linkAllowedFrom(cfg, ip, now) {
  const bucket = await hmac(cfg.appSecret, 'admin-ip', `${ip || 'unknown'}|${Math.floor(now / DAY)}`);
  return take(cfg, bucket, now, 10 * MINUTE, ADMIN.ipPerTenMinutes, DAY, ADMIN.ipPerDay);
}

// ---------- sign-in links ----------

const codeHash = (cfg, email, code) => hmac(cfg.appSecret, 'admin-code', `${email}|${code}`);

function randomCode() {
  // 6 digits, uniform: reject values that would bias the modulo.
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= 4294000000);
  return String(buf[0] % 1000000).padStart(6, '0');
}

/**
 * Makes a link for a team address and emails it. Runs after the answer has gone out (waitUntil), so an allowed
 * address and an unknown one take the same time and get the same answer. Unknown addresses get nothing.
 */
export async function requestLink(cfg, email, now) {
  if (!cfg.adminEmails.has(email)) { log(cfg.adminEmails.size ? 'admin_link_not_allowed' : 'admin_emails_empty'); return; }
  const token = randomToken();
  const code = randomCode();
  // The cap is checked in the same statement as the insert, so parallel requests can't pass it.
  const res = await cfg.db.prepare(
    `INSERT INTO admin_links (token_hash, code_hash, email, attempts, created_at, expires_at)
     SELECT ?1, ?2, ?3, 0, ?4, ?5
     WHERE (SELECT COUNT(*) FROM admin_links WHERE email = ?3 AND created_at > ?6) < ?7`,
  ).bind(await sha256(token), await codeHash(cfg, email, code), email, now, now + ADMIN.linkTtl, now - ADMIN.linkTtl, ADMIN.linksPerEmail).run();
  if (!res.meta || res.meta.changes !== 1) { log('admin_link_email_capped'); return; }
  const msg = adminLinkEmail({ siteUrl: cfg.siteUrl, linkUrl: `${cfg.siteUrl}/admin/#hyr=${token}`, code, ttlMinutes: ADMIN.linkTtl / MINUTE });
  try {
    await sendEmail(cfg.email, { to: email, ...msg });
    log('admin_link_sent');
  } catch (e) {
    log('admin_link_send_failed', { reason: e.message });
  }
}

async function startSession(cfg, email, now) {
  const token = randomToken();
  await cfg.db.prepare('INSERT INTO sessions (token_hash, kind, subject, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(await sha256(token), 'admin', email, now, now + ADMIN.sessionTtl).run();
  return token;
}

/**
 * Signs in with the link's token. Single use: only the request that marks it used gets in. The address must still
 * be in ADMIN_EMAILS.
 * @returns {{ result: 'ok', token: string } | { result: 'expired' }}
 */
export async function useLink(cfg, linkToken, now) {
  if (typeof linkToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(linkToken)) return { result: 'expired' };
  const { results } = await cfg.db.prepare(
    'UPDATE admin_links SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1 RETURNING email',
  ).bind(now, await sha256(linkToken)).all();
  const email = results && results[0] && results[0].email;
  if (!email || !cfg.adminEmails.has(email)) { log('admin_link_expired'); return { result: 'expired' }; }
  log('admin_signin_ok', { via: 'link' });
  return { result: 'ok', token: await startSession(cfg, email, now) };
}

/**
 * Signs in with the code from the newest live link sent to this address. Every try is counted before the code is
 * compared (5 per link, 20 per address a day), so parallel guesses can't get more. An address without a link gets
 * the same answer as a wrong code.
 * @returns {{ result: 'ok', token: string } | { result: 'invalid' }}
 */
export async function useCode(cfg, email, code, now) {
  const db = cfg.db;
  if (!(await take(cfg, await hmac(cfg.appSecret, 'admin-code-tries', email), now, DAY, ADMIN.codeTriesPerDay))) {
    log('admin_code_daily_cap');
    return { result: 'invalid' };
  }
  const row = await db.prepare(
    `SELECT token_hash, code_hash FROM admin_links WHERE email = ?1 AND used_at IS NULL AND expires_at > ?2 AND attempts < ?3
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(email, now, ADMIN.codeAttempts).first();
  if (!row) return { result: 'invalid' };
  const tried = await db.prepare(
    'UPDATE admin_links SET attempts = attempts + 1 WHERE token_hash = ?1 AND attempts < ?2 AND used_at IS NULL',
  ).bind(row.token_hash, ADMIN.codeAttempts).run();
  if (!tried.meta || tried.meta.changes !== 1) return { result: 'invalid' };
  if (!safeEqual(await codeHash(cfg, email, code), row.code_hash)) { log('admin_code_wrong'); return { result: 'invalid' }; }
  const used = await db.prepare('UPDATE admin_links SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1')
    .bind(now, row.token_hash).run();
  if (!used.meta || used.meta.changes !== 1 || !cfg.adminEmails.has(email)) return { result: 'invalid' };
  log('admin_signin_ok', { via: 'code' });
  return { result: 'ok', token: await startSession(cfg, email, now) };
}

// ---------- sessions ----------

export function adminCookie(cfg, token, maxAgeMs) {
  const secure = cfg.local ? '' : ' Secure;';
  return `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

/** The signed-in team member ({ email }) for this request, or null. Removing an address from ADMIN_EMAILS locks it out at once. */
export async function currentAdmin(cfg, request, now) {
  const token = readCookie(request, ADMIN_COOKIE);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await cfg.db.prepare(
    "SELECT subject FROM sessions WHERE token_hash = ?1 AND kind = 'admin' AND expires_at > ?2",
  ).bind(await sha256(token), now).first();
  if (!row || !cfg.adminEmails.has(row.subject)) return null;
  return { email: row.subject };
}

export async function endAdminSession(cfg, request) {
  const token = readCookie(request, ADMIN_COOKIE);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  await cfg.db.prepare("DELETE FROM sessions WHERE token_hash = ?1 AND kind = 'admin'").bind(await sha256(token)).run();
  log('admin_signout');
}

/** Background cleanup after link requests: old link records. (Sessions and rate records: signinMaintenance.) */
export async function adminMaintenance(cfg, now) {
  await cfg.db.prepare('DELETE FROM admin_links WHERE created_at < ?1').bind(now - ADMIN.keepLinks).run();
}

// ---------- the list ----------

export const LIST_FILTERS = ['pending', 'approved', 'rejected', 'suspended', 'draft', 'changed', 'all'];
const STATUSES = ['draft', 'pending', 'approved', 'rejected', 'suspended'];

const parseList = (json) => { try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; } };
const changedSince = (r) => r.status === 'approved' && r.edited_at !== null && r.approved_at !== null && r.edited_at > r.approved_at;

/** For search: lowercase, without accents, so "ë" finds "e" and "Çerkezi" finds "cerkezi". */
export const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();

/** The digits of a phone search, without the country code or the leading 0; '' when fewer than 3 remain. */
function phoneDigits(q) {
  const d = q.replace(/\D/g, '').replace(/^(00383|383|0)/, '');
  return d.length >= 3 ? d : '';
}

/**
 * The approval queue and the other lists, with the count for every filter. Pending: oldest sent first, so nobody
 * waits longest; the others: last changed first. `q` matches the name (without accents) or the phone's digits.
 */
export async function listPros(cfg, filter, rawQ) {
  const db = cfg.db;
  const c = await db.prepare(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
       SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
       SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended,
       SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
       SUM(CASE WHEN status = 'approved' AND edited_at > approved_at THEN 1 ELSE 0 END) AS changed
     FROM pros`,
  ).first();
  const counts = {
    pending: c.pending || 0, approved: c.approved || 0, rejected: c.rejected || 0, suspended: c.suspended || 0,
    draft: c.draft || 0, changed: c.changed || 0, all: c.total || 0,
  };

  const q = String(rawQ || '').slice(0, ADMIN.searchMax);
  const name = fold(q);
  const digits = phoneDigits(q);
  const where = filter === 'all' ? '' : filter === 'changed'
    ? "WHERE p.status = 'approved' AND p.edited_at > p.approved_at"
    : 'WHERE p.status = ?2';
  const order = filter === 'pending' ? 'p.submitted_at ASC, p.created_at ASC' : 'p.updated_at DESC, p.created_at DESC';
  // Without a search the database stops at the cap; with one, the whole filter is read and matched here.
  const { results } = await db.prepare(
    `SELECT p.id, p.phone, p.name, p.status, p.verified, p.trades, p.towns, p.submitted_at, p.updated_at, p.approved_at,
            p.created_at, p.edited_at,
            (SELECT ph.id FROM pro_photos ph WHERE ph.pro_id = p.id AND ph.kind = 'profile' ORDER BY ph.created_at DESC LIMIT 1) AS photo_id
     FROM pros p ${where} ORDER BY ${order} LIMIT ?1`,
  ).bind(name ? 100000 : ADMIN.listMax + 1, ...(STATUSES.includes(filter) ? [filter] : [])).all();
  const found = name
    ? results.filter((r) => fold(r.name).includes(name) || (digits && r.phone.includes(digits)))
    : results;
  return {
    counts,
    truncated: found.length > ADMIN.listMax,
    items: found.slice(0, ADMIN.listMax).map((r) => ({
      id: r.id,
      name: r.name,
      phone: formatPhone(r.phone),
      status: r.status,
      verified: r.verified === 1,
      trades: parseList(r.trades),
      towns: parseList(r.towns),
      photo: r.photo_id ? `/foto/${r.photo_id}.jpg` : null,
      submittedAt: r.submitted_at,
      updatedAt: r.updated_at,
      approvedAt: r.approved_at,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      changedSinceApproval: changedSince(r),
    })),
  };
}

// ---------- one mjeshtër ----------

export const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id);

/** Everything the detail view shows: the dashboard's view of the profile, plus the dates and the history. Null when gone. */
export async function loadPro(cfg, id, now) {
  if (!validId(id)) return null;
  const db = cfg.db;
  const row = await db.prepare(
    'SELECT id, phone, name, handle, status, created_at, updated_at, approved_at, edited_at, last_login_at FROM pros WHERE id = ?1',
  ).bind(id).first();
  if (!row) return null;
  const [dash, history] = await Promise.all([
    loadDashboard(cfg, id, now),
    db.prepare(`SELECT at, admin, action, note, public_note FROM admin_log WHERE pro_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2`)
      .bind(id, ADMIN.logRows).all(),
  ]);
  if (!dash) return null;
  return {
    id: row.id,
    phone: dash.phone,
    phoneE164: row.phone,
    profile: dash.profile,
    photos: dash.photos,
    photosEnabled: dash.photosEnabled,
    checklist: dash.checklist,
    stats: dash.stats,
    status: dash.status,
    statusNote: dash.statusNote,
    verified: dash.verified,
    available: dash.available,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: dash.submittedAt,
    approvedAt: row.approved_at,
    // The public profile's address; the team can open it even before the directory opens.
    publicPath: dash.status === 'approved' && row.handle ? profilePath(dash.profile.name, row.handle) : null,
    editedAt: row.edited_at,
    changedSinceApproval: changedSince(row),
    lastLoginAt: row.last_login_at,
    log: history.results.map((r) => ({ at: r.at, admin: r.admin, action: r.action, note: r.note, publicNote: r.public_note })),
  };
}

/** One line of history: who in the team did what, with the team's own note and the reason the mjeshtër sees. */
export async function logAction(cfg, { proId, admin, action, note = '', publicNote = '' }, now) {
  await cfg.db.prepare('INSERT INTO admin_log (pro_id, at, admin, action, note, public_note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(proId, now, admin, action, note, publicNote).run();
}

// ---------- decisions ----------

export const ACTIONS = ['approve', 'reject', 'suspend', 'unsuspend', 'verify', 'unverify', 'seen'];

// The statuses each action may start from. verify/unverify work in any status.
const FROM = {
  approve: ['draft', 'pending', 'rejected'],
  reject: ['pending', 'approved'],
  suspend: ['draft', 'pending', 'approved', 'rejected'],
  unsuspend: ['suspended'],
  seen: ['approved'],
};

/**
 * Checks a decision from the panel.
 * @returns {{ action, note, internalNote, notify, seenEditedAt } | { error: { message: string, field?: string } }}
 */
export function readDecision(data) {
  const action = data.action;
  if (!ACTIONS.includes(action)) return { error: { message: ADMIN_MESSAGES.actionInvalid, field: 'action' } };
  const internalNote = cleanText(data.internalNote);
  if (internalNote.length > ADMIN.noteMax) return { error: { message: ADMIN_MESSAGES.internalNoteTooLong, field: 'internalNote' } };
  let note = '';
  if (action === 'reject' || action === 'suspend') {
    note = cleanText(data.note);
    if (note.length < ADMIN.noteMin || note.length > ADMIN.noteMax) return { error: { message: ADMIN_MESSAGES.noteInvalid, field: 'note' } };
  }
  let seenEditedAt = null;
  if (action === 'approve' || action === 'seen') {
    // The editedAt the team was looking at (null when never edited): approving checks nothing changed since.
    seenEditedAt = data.seenEditedAt;
    if (seenEditedAt !== null && !Number.isSafeInteger(seenEditedAt)) return { error: { message: MESSAGES.generic, field: 'seenEditedAt' } };
  }
  return { action, note, internalNote, notify: data.notify !== false, seenEditedAt };
}

const SMS_TEXT = {
  approve: (siteUrl) => `Rregullo: Profili yt u aprovua. Klientet do te te gjejne sapo te hapet kerkimi. ${siteUrl}/mjeshtri`,
  reject: (siteUrl) => `Rregullo: Ekipi kerkon disa ndryshime ne profilin tend. Shiko arsyen: ${siteUrl}/mjeshtri`,
};

/**
 * Texts the mjeshtër about an approval or a rejection. Never undoes the decision. Capped at 3 per mjeshtër and 50 in
 * all per 24 hours, counted before sending (a failed send still counts) in one statement.
 * @returns {Promise<'sent' | 'failed' | 'off' | 'skipped' | 'capped'>}
 */
async function notifyPro(cfg, pro, action, notify, now) {
  if (!notify) return 'skipped';
  if (!smsConfigured(cfg.sms)) return 'off';
  const mine = await hmac(cfg.appSecret, 'notify-sms', pro.id);
  const all = await hmac(cfg.appSecret, 'notify-sms-all', 'all');
  const res = await cfg.db.prepare(
    `INSERT INTO rate_events (bucket, at) SELECT b, ?3 FROM (SELECT ?1 AS b UNION ALL SELECT ?2 AS b)
     WHERE (SELECT COUNT(*) FROM rate_events WHERE bucket = ?1 AND at > ?4) < ?5
       AND (SELECT COUNT(*) FROM rate_events WHERE bucket = ?2 AND at > ?4) < ?6`,
  ).bind(mine, all, now, now - DAY, ADMIN.smsPerPro, ADMIN.smsPerDay).run();
  if (!res.meta || res.meta.changes !== 2) { log('admin_sms_capped'); return 'capped'; }
  try {
    await sendSms(cfg.sms, pro.phoneE164, SMS_TEXT[action](cfg.siteUrl));
    log('admin_sms_sent', { action });
    return 'sent';
  } catch (e) {
    log('admin_sms_failed', { reason: e.message });
    return 'failed';
  }
}

/**
 * Applies a decision to the profile `pro` (as loadPro read it). Every change is conditional on the status (and for
 * approve/seen on edited_at) in SQL, so two team members at once, or a mjeshtër editing meanwhile, can't produce an
 * impossible change: the loser gets 'state' or 'edited'.
 * @returns {Promise<{ result: 'ok', message: string, sms: string | null }
 *   | { result: 'missing', missing: string[] } | { result: 'state' | 'edited' | 'gone' }>}
 */
export async function decide(cfg, admin, pro, d, now) {
  const db = cfg.db;
  const { action } = d;
  if (FROM[action] && !FROM[action].includes(pro.status)) return { result: 'state' };
  if ((action === 'approve' || action === 'seen') && pro.editedAt !== d.seenEditedAt) return { result: 'edited' };

  let res;
  let message;
  if (action === 'approve') {
    if (!pro.checklist.ready) {
      return { result: 'missing', missing: pro.checklist.items.filter((i) => i.required && !i.done).map((i) => i.key) };
    }
    res = await db.prepare(
      // The first approval also gives the profile its public address (/m/<name>-<handle>), which never changes.
      `UPDATE pros SET status = 'approved', status_note = '', approved_at = ?2, updated_at = ?2, handle = COALESCE(handle, ?4)
       WHERE id = ?1 AND status IN ('draft', 'pending', 'rejected') AND edited_at IS ?3`,
    ).bind(pro.id, now, d.seenEditedAt, newHandle()).run();
    message = ADMIN_MESSAGES.approved;
  } else if (action === 'seen') {
    res = await db.prepare(
      "UPDATE pros SET approved_at = ?2, updated_at = ?2 WHERE id = ?1 AND status = 'approved' AND edited_at IS ?3",
    ).bind(pro.id, now, d.seenEditedAt).run();
    message = ADMIN_MESSAGES.seen;
  } else if (action === 'reject') {
    res = await db.prepare(
      "UPDATE pros SET status = 'rejected', status_note = ?2, updated_at = ?3 WHERE id = ?1 AND status IN ('pending', 'approved')",
    ).bind(pro.id, d.note, now).run();
    message = ADMIN_MESSAGES.rejected;
  } else if (action === 'suspend') {
    res = await db.prepare(
      "UPDATE pros SET status = 'suspended', status_note = ?2, updated_at = ?3 WHERE id = ?1 AND status != 'suspended'",
    ).bind(pro.id, d.note, now).run();
    message = ADMIN_MESSAGES.suspended;
  } else if (action === 'unsuspend') {
    // Back in the queue when the profile has what sending needs; otherwise a draft the mjeshtër completes and sends.
    const to = pro.checklist.ready ? 'pending' : 'draft';
    res = await db.prepare(
      `UPDATE pros SET status = ?2, status_note = '', submitted_at = CASE WHEN ?2 = 'pending' THEN ?3 ELSE submitted_at END,
         updated_at = ?3 WHERE id = ?1 AND status = 'suspended'`,
    ).bind(pro.id, to, now).run();
    message = to === 'pending' ? ADMIN_MESSAGES.unsuspendedPending : ADMIN_MESSAGES.unsuspendedDraft;
  } else {
    const on = action === 'verify' ? 1 : 0;
    res = await db.prepare('UPDATE pros SET verified = ?2, updated_at = ?3 WHERE id = ?1 AND verified != ?2').bind(pro.id, on, now).run();
    message = on ? ADMIN_MESSAGES.verified : ADMIN_MESSAGES.unverified;
    // Already so: nothing to record, the answer is the same.
    if (!res.meta || res.meta.changes !== 1) {
      const still = await db.prepare('SELECT verified FROM pros WHERE id = ?1').bind(pro.id).first();
      return still ? { result: 'ok', message, sms: null } : { result: 'gone' };
    }
  }

  if (!res.meta || res.meta.changes !== 1) {
    const fresh = await db.prepare('SELECT status, edited_at FROM pros WHERE id = ?1').bind(pro.id).first();
    if (!fresh) return { result: 'gone' };
    if ((action === 'approve' || action === 'seen') && fresh.edited_at !== d.seenEditedAt) return { result: 'edited' };
    return { result: 'state' };
  }
  await logAction(cfg, { proId: pro.id, admin, action, note: d.internalNote, publicNote: d.note }, now);
  log('admin_decision', { action });
  const sms = action === 'approve' || action === 'reject' ? await notifyPro(cfg, pro, action, d.notify, now) : null;
  return { result: 'ok', message, sms };
}

// ---------- adding a mjeshtër ----------

/**
 * Adds a mjeshtër by phone number, with their OK, for those who can't do it on a phone: a draft, as after a first
 * sign-in but never signed in. They can sign in later with the number and take it over.
 * @returns {Promise<{ result: 'created' | 'exists', id: string } | { result: 'too_many' }>}
 */
export async function createPro(cfg, admin, phone, now) {
  const db = cfg.db;
  const existing = await db.prepare('SELECT id FROM pros WHERE phone = ?1').bind(phone).first();
  if (existing) return { result: 'exists', id: existing.id };
  if (!(await take(cfg, await hmac(cfg.appSecret, 'admin-add', admin), now, DAY, ADMIN.addsPerDay))) {
    log('admin_add_capped');
    return { result: 'too_many' };
  }
  const id = uuid();
  const res = await db.prepare('INSERT INTO pros (id, phone, created_at, updated_at) VALUES (?1, ?2, ?3, ?3) ON CONFLICT (phone) DO NOTHING')
    .bind(id, phone, now).run();
  if (!res.meta || res.meta.changes !== 1) {
    const row = await db.prepare('SELECT id FROM pros WHERE phone = ?1').bind(phone).first();
    return { result: 'exists', id: row.id };
  }
  await logAction(cfg, { proId: id, admin, action: 'created', note: 'pëlqim i dhënë' }, now);
  log('admin_pro_created');
  return { result: 'created', id };
}

// ---------- telling the team ----------

/**
 * After a mjeshtër sends a profile: emails every team address that the queue has something new, at most once an
 * hour (the hour's mark is taken in one statement, so two submits at once send one email). Nothing about the
 * mjeshtër is in it. Skipped when no team address or email setting exists.
 */
export async function notifyQueue(env, now) {
  const cfg = readAdminConfig(env);
  if (!cfg.adminEmails.size || missingAdminConfig(cfg, { email: true }).length) return;
  const hour = Math.floor(now / HOUR);
  const res = await cfg.db.prepare(
    'INSERT INTO rate_events (bucket, at) SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM rate_events WHERE bucket = ?1)',
  ).bind(await hmac(cfg.appSecret, 'admin-queue', String(hour)), now).run();
  if (!res.meta || res.meta.changes !== 1) return;
  const row = await cfg.db.prepare("SELECT COUNT(*) AS n FROM pros WHERE status = 'pending'").first();
  const msg = adminQueueEmail({ siteUrl: cfg.siteUrl, pendingCount: row.n });
  let sent = 0;
  for (const to of cfg.adminEmails) {
    try {
      // One key per hour and address: the provider refuses a key reused with another recipient.
      const key = `queue-${hour}-${(await hmac(cfg.appSecret, 'admin-queue-to', to)).slice(0, 16)}`;
      await sendEmail(cfg.email, { to, ...msg, idempotencyKey: key });
      sent++;
    } catch (e) {
      log('admin_queue_email_failed', { reason: e.message });
    }
  }
  log('admin_queue_email_sent', { sent });
}
