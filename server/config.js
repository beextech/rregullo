// Settings for the launch-notification backend. Secrets come from the environment only
// (Cloudflare Worker: Settings > Variables and Secrets; locally: .dev.vars). Nothing secret lives in Git.

// The consent wording on the form. Bump the version whenever the wording changes, and keep the old
// text here, so every stored consent can be traced back to the exact words the person agreed to.
export const CONSENT_VERSION = 'launch-notify-v1';
export const CONSENT_TEXTS = {
  'launch-notify-v1': 'Pranoj që Rregullo ta ruajë adresën time të emailit për të më njoftuar rreth lansimit të platformës. E kuptoj që mund të çregjistrohem në çdo kohë.',
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const LIMITS = {
  confirmTokenTtl: 48 * HOUR,          // the confirmation link works for 48 hours
  confirmResendGap: 2 * MINUTE,        // at most one confirmation email per address every 2 minutes
  confirmMaxPerWindow: 3,              // and at most 3 in 24 hours
  confirmWindow: DAY,
  ipPerTenMinutes: 6,                  // signup requests per IP
  ipPerDay: 30,
  teamNotifyMaxAttempts: 5,
};

export const RETENTION = {
  pending: 7 * DAY,                    // unconfirmed signups are deleted 7 days after the last request
  rateEvents: DAY,                     // abuse-protection records
  unsubscribedHash: 365 * DAY,         // the keyed hash kept after an unsubscribe, to honour it, then deleted
  afterLaunch: 180 * DAY,              // confirmed addresses are deleted 6 months after the launch email
};

export function readConfig(env) {
  const siteUrl = (env.SITE_URL || '').replace(/\/$/, '');
  const missing = [];
  if (!env.DB) missing.push('DB (D1 binding)');
  if (!siteUrl) missing.push('SITE_URL');
  if (!env.APP_SECRET || env.APP_SECRET.length < 32) missing.push('APP_SECRET (32+ characters)');
  if (!env.RESEND_API_KEY) missing.push('RESEND_API_KEY');
  if (!env.EMAIL_FROM) missing.push('EMAIL_FROM');
  return {
    missing,
    siteUrl,
    db: env.DB,
    appSecret: env.APP_SECRET,
    email: {
      apiKey: env.RESEND_API_KEY,
      apiBase: (env.EMAIL_API_BASE || 'https://api.resend.com').replace(/\/$/, ''),
      from: env.EMAIL_FROM,
      replyTo: env.EMAIL_REPLY_TO || '',
    },
    // Where the team hears about signups. Optional: without it, nothing is sent to the team.
    teamEmail: env.LAUNCH_NOTIFICATION_EMAIL || '',
    // 'confirmed' (default): one email per confirmed signup. 'all': also when a signup is requested.
    teamNotifyOn: env.LAUNCH_NOTIFY_ON === 'all' ? 'all' : 'confirmed',
  };
}

export { MINUTE, HOUR, DAY };
