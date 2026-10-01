-- Launch-notification list. Only what the double opt-in and the launch email need.
-- Times are Unix epoch milliseconds.

CREATE TABLE subscribers (
  id                    TEXT PRIMARY KEY,               -- random UUID; the only id that ever appears in a URL
  email                 TEXT,                           -- NULL once the person unsubscribes
  email_hash            TEXT NOT NULL UNIQUE,           -- keyed HMAC of the normalised address: dedupe + suppression
  status                TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  consent_version       TEXT,                           -- which consent wording was accepted (see server/config.js)
  consent_at            INTEGER,                        -- when the box was ticked and the form accepted
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  confirm_token_hash    TEXT UNIQUE,                    -- SHA-256 of the emailed token; cleared on use (single-use)
  confirm_expires_at    INTEGER,
  confirm_sent_count    INTEGER NOT NULL DEFAULT 0,     -- confirmation emails sent in the current window
  confirm_window_start  INTEGER,
  confirm_last_sent_at  INTEGER,
  confirm_email_status  TEXT,                           -- 'sent' | 'failed'
  confirmed_at          INTEGER,
  unsubscribed_at       INTEGER,
  team_notify_status    TEXT,                           -- 'sent' | 'failed' | NULL (not needed)
  team_notify_attempts  INTEGER NOT NULL DEFAULT 0,
  launch_sent_at        INTEGER                         -- set by scripts/send-launch.mjs
);

CREATE INDEX subscribers_status ON subscribers (status);
CREATE INDEX subscribers_team_notify ON subscribers (team_notify_status);

-- Abuse protection: one row per accepted request, keyed by a daily-rotating HMAC of the IP. Kept 24 hours.
CREATE TABLE rate_events (
  bucket  TEXT NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX rate_events_bucket_at ON rate_events (bucket, at);
