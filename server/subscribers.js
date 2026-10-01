// The launch list: signup with double opt-in, confirmation, unsubscribe, retention and team notices.
// Every query is a prepared statement with bound parameters.

import { CONSENT_VERSION, LIMITS, RETENTION } from './config.js';
import { emailHash, ipBucket, randomToken, safeEqual, sha256, unsubscribeSig, uuid } from './crypto.js';
import { sendEmail } from './email.js';
import { confirmationEmail, teamNotificationEmail } from './templates.js';
import { maskEmail } from './validate.js';

/** Log without personal data: an event name and non-identifying details only. */
export function log(event, details = {}) {
  console.log(JSON.stringify({ event, ...details }));
}

// ---------- abuse protection ----------

/** Returns true when this IP has made too many signup requests. Records the request otherwise. */
export async function rateLimited(cfg, ip, now) {
  const bucket = await ipBucket(cfg.appSecret, ip || 'unknown', now);
  const row = await cfg.db.prepare(
    'SELECT SUM(CASE WHEN at > ?2 THEN 1 ELSE 0 END) AS recent, COUNT(*) AS day FROM rate_events WHERE bucket = ?1 AND at > ?3',
  ).bind(bucket, now - 10 * 60 * 1000, now - 24 * 60 * 60 * 1000).first();
  if ((row?.recent || 0) >= LIMITS.ipPerTenMinutes || (row?.day || 0) >= LIMITS.ipPerDay) return true;
  await cfg.db.prepare('INSERT INTO rate_events (bucket, at) VALUES (?1, ?2)').bind(bucket, now).run();
  return false;
}

// ---------- signup ----------

/**
 * Creates or refreshes a pending signup and sends the confirmation email when allowed.
 * The caller always shows the same "check your email" result for accepted requests, whether the
 * address is new, pending or already confirmed, so the form never reveals who is on the list.
 *
 * @returns {{ result: 'accepted' | 'send_failed', notifyTeam?: string }}
 */
export async function requestSignup(cfg, email, now) {
  const hash = await emailHash(cfg.appSecret, email);
  const db = cfg.db;
  const row = await db.prepare(
    'SELECT id, status, confirm_sent_count, confirm_window_start, confirm_last_sent_at FROM subscribers WHERE email_hash = ?1',
  ).bind(hash).first();

  if (row && row.status === 'confirmed') {
    log('signup_already_confirmed');
    return { result: 'accepted' };
  }

  // Resend limits for an address that is already pending.
  let sentCount = 0;
  let windowStart = now;
  if (row && row.status === 'pending') {
    const inWindow = row.confirm_window_start && now - row.confirm_window_start < LIMITS.confirmWindow;
    sentCount = inWindow ? row.confirm_sent_count : 0;
    windowStart = inWindow ? row.confirm_window_start : now;
    const tooSoon = row.confirm_last_sent_at && now - row.confirm_last_sent_at < LIMITS.confirmResendGap;
    if (tooSoon || sentCount >= LIMITS.confirmMaxPerWindow) {
      log('signup_resend_suppressed', { reason: tooSoon ? 'too_soon' : 'window_cap' });
      return { result: 'accepted' };
    }
  }

  const id = row ? row.id : uuid();
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expires = now + LIMITS.confirmTokenTtl;

  // New, pending or previously unsubscribed: (re)start a pending signup with fresh consent.
  await db.prepare(
    `INSERT INTO subscribers (id, email, email_hash, status, consent_version, consent_at, created_at, updated_at,
                              confirm_token_hash, confirm_expires_at, confirm_sent_count, confirm_window_start,
                              confirm_email_status, unsubscribed_at, confirmed_at, team_notify_status, team_notify_attempts)
     VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?5, ?5, ?6, ?7, ?8, ?9, NULL, NULL, NULL, NULL, 0)
     ON CONFLICT (email_hash) DO UPDATE SET
       email = excluded.email, status = 'pending', consent_version = excluded.consent_version,
       consent_at = excluded.consent_at, updated_at = excluded.updated_at,
       confirm_token_hash = excluded.confirm_token_hash, confirm_expires_at = excluded.confirm_expires_at,
       confirm_sent_count = excluded.confirm_sent_count, confirm_window_start = excluded.confirm_window_start,
       unsubscribed_at = NULL, confirmed_at = NULL
     WHERE subscribers.status <> 'confirmed'`,
  ).bind(id, email, hash, CONSENT_VERSION, now, tokenHash, expires, sentCount, windowStart).run();

  const confirmUrl = `${cfg.siteUrl}/konfirmo?t=${token}`;
  const msg = confirmationEmail({ siteUrl: cfg.siteUrl, confirmUrl, ttlHours: Math.round(LIMITS.confirmTokenTtl / 3600000) });
  try {
    await sendEmail(cfg.email, { to: email, ...msg, idempotencyKey: `confirm-${tokenHash.slice(0, 32)}` });
  } catch (e) {
    // Keep the pending record; a later attempt from the form sends a new link. Failed sends don't count.
    await db.prepare('UPDATE subscribers SET confirm_email_status = ?2, updated_at = ?3 WHERE id = ?1')
      .bind(id, 'failed', now).run();
    log('confirm_email_failed', { reason: e.message });
    return { result: 'send_failed' };
  }
  await db.prepare(
    `UPDATE subscribers SET confirm_email_status = 'sent', confirm_sent_count = confirm_sent_count + 1,
       confirm_last_sent_at = ?2, updated_at = ?2 WHERE id = ?1`,
  ).bind(id, now).run();
  log('confirm_email_sent');
  return { result: 'accepted', notifyTeam: cfg.teamNotifyOn === 'all' ? id : undefined };
}

// ---------- confirmation ----------

/** @returns {{ result: 'confirmed' | 'expired' | 'invalid', id?: string }} */
export async function confirmToken(cfg, token, now) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return { result: 'invalid' };
  const tokenHash = await sha256(token);
  const row = await cfg.db.prepare(
    "SELECT id, confirm_expires_at FROM subscribers WHERE confirm_token_hash = ?1 AND status = 'pending'",
  ).bind(tokenHash).first();
  if (!row) return { result: 'invalid' };
  if (row.confirm_expires_at < now) {
    await cfg.db.prepare('UPDATE subscribers SET confirm_token_hash = NULL, updated_at = ?2 WHERE id = ?1').bind(row.id, now).run();
    return { result: 'expired' };
  }
  // Single use: the update only succeeds while the token is still stored, and it clears it.
  const res = await cfg.db.prepare(
    `UPDATE subscribers SET status = 'confirmed', confirmed_at = ?3, updated_at = ?3, confirm_token_hash = NULL,
       confirm_expires_at = NULL, team_notify_status = CASE WHEN ?4 THEN 'queued' ELSE NULL END, team_notify_attempts = 0
     WHERE id = ?1 AND confirm_token_hash = ?2 AND status = 'pending'`,
  ).bind(row.id, tokenHash, now, cfg.teamEmail ? 1 : 0).run();
  if (!res.meta || res.meta.changes !== 1) return { result: 'invalid' };
  log('subscriber_confirmed');
  return { result: 'confirmed', id: row.id };
}

// ---------- unsubscribe ----------

export async function unsubscribeUrl(cfg, id) {
  return `${cfg.siteUrl}/cregjistrohu?s=${encodeURIComponent(id)}&t=${await unsubscribeSig(cfg.appSecret, id)}`;
}

export async function verifyUnsubscribe(cfg, id, sig) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) || typeof sig !== 'string') return false;
  return safeEqual(sig, await unsubscribeSig(cfg.appSecret, id));
}

/** Deletes the address and keeps only the keyed hash, so the unsubscribe is honoured. Idempotent. */
export async function unsubscribe(cfg, id, now) {
  await cfg.db.prepare(
    `UPDATE subscribers SET status = 'unsubscribed', email = NULL, unsubscribed_at = COALESCE(unsubscribed_at, ?2),
       updated_at = ?2, confirm_token_hash = NULL, confirm_expires_at = NULL, team_notify_status = NULL
     WHERE id = ?1`,
  ).bind(id, now).run();
  log('subscriber_unsubscribed');
}

// ---------- team notifications ----------

async function totals(db) {
  const r = await db.prepare(
    "SELECT SUM(status = 'confirmed') AS confirmed, SUM(status = 'pending') AS pending FROM subscribers",
  ).first();
  return { confirmed: r?.confirmed || 0, pending: r?.pending || 0 };
}

/** Sends the team a note about one subscriber. Failures are recorded and retried by maintenance(). */
export async function notifyTeam(cfg, id, event, now) {
  if (!cfg.teamEmail) return;
  const row = await cfg.db.prepare('SELECT email, status, confirmed_at, created_at FROM subscribers WHERE id = ?1').bind(id).first();
  if (!row || row.status === 'unsubscribed') return;
  const msg = teamNotificationEmail({
    event, maskedEmail: maskEmail(row.email), at: (event === 'confirmed' ? row.confirmed_at : now) || now, totals: await totals(cfg.db),
  });
  try {
    await sendEmail(cfg.email, { to: cfg.teamEmail, ...msg, idempotencyKey: `team-${event}-${id}` });
    if (event === 'confirmed') {
      await cfg.db.prepare("UPDATE subscribers SET team_notify_status = 'sent' WHERE id = ?1").bind(id).run();
    }
    log('team_notified', { kind: event });
  } catch (e) {
    if (event === 'confirmed') {
      await cfg.db.prepare("UPDATE subscribers SET team_notify_status = 'failed', team_notify_attempts = team_notify_attempts + 1 WHERE id = ?1").bind(id).run();
    }
    log('team_notify_failed', { kind: event, reason: e.message });
  }
}

// ---------- retention and retries ----------

/** Runs after requests (in the background). Cheap: a few indexed deletes and at most 3 retries. */
export async function maintenance(cfg, now) {
  const db = cfg.db;
  await db.batch([
    db.prepare("DELETE FROM subscribers WHERE status = 'pending' AND updated_at < ?1").bind(now - RETENTION.pending),
    db.prepare("DELETE FROM subscribers WHERE status = 'unsubscribed' AND unsubscribed_at < ?1").bind(now - RETENTION.unsubscribedHash),
    db.prepare("DELETE FROM subscribers WHERE status = 'confirmed' AND launch_sent_at IS NOT NULL AND launch_sent_at < ?1").bind(now - RETENTION.afterLaunch),
    db.prepare('DELETE FROM rate_events WHERE at < ?1').bind(now - RETENTION.rateEvents),
  ]);
  if (!cfg.teamEmail) return;
  const { results } = await db.prepare(
    `SELECT id FROM subscribers WHERE status = 'confirmed' AND team_notify_status IN ('failed', 'queued')
       AND team_notify_attempts < ?1 AND updated_at < ?2 LIMIT 3`,
  ).bind(LIMITS.teamNotifyMaxAttempts, now - 60 * 1000).all();
  for (const r of results || []) await notifyTeam(cfg, r.id, 'confirmed', now);
}
