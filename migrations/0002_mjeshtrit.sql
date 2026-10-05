-- The Rregullo app: mjeshtër profiles, their sign-in (SMS codes and sessions) and the team's sign-in (email links).
-- Clients have no account and nothing about them is stored here. Times are Unix epoch milliseconds.

CREATE TABLE pros (
  id            TEXT PRIMARY KEY,                     -- random UUID
  phone         TEXT NOT NULL UNIQUE,                 -- E.164, +383 4x xxx xxx: the sign-in and the number clients call
  name          TEXT NOT NULL DEFAULT '',
  about         TEXT NOT NULL DEFAULT '',
  trades        TEXT NOT NULL DEFAULT '[]',           -- JSON array of trade slugs (src/mjeshtri/catalog.js)
  towns         TEXT NOT NULL DEFAULT '[]',           -- JSON array of municipality slugs
  years         INTEGER,                              -- years of experience, optional
  price_note    TEXT NOT NULL DEFAULT '',             -- optional, e.g. "nga 20 € / orë"
  whatsapp      INTEGER NOT NULL DEFAULT 0,           -- 1: the same number takes WhatsApp
  viber         INTEGER NOT NULL DEFAULT 0,
  available     INTEGER NOT NULL DEFAULT 1,           -- "Marr punë tani"
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'suspended')),
  status_note   TEXT NOT NULL DEFAULT '',             -- the team's reason, shown to the mjeshtër on reject/suspend
  verified      INTEGER NOT NULL DEFAULT 0,           -- "Verifikuar": the team has checked them
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  submitted_at  INTEGER,
  approved_at   INTEGER,
  last_login_at INTEGER
);
CREATE INDEX pros_status ON pros (status, submitted_at);

-- Per-day counters the public directory will fill (profile views and taps on call, WhatsApp, Viber).
CREATE TABLE pro_stats_daily (
  pro_id    TEXT NOT NULL,
  day       TEXT NOT NULL,                            -- YYYY-MM-DD (UTC)
  views     INTEGER NOT NULL DEFAULT 0,
  calls     INTEGER NOT NULL DEFAULT 0,
  whatsapp  INTEGER NOT NULL DEFAULT 0,
  viber     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pro_id, day)
);

-- One pending sign-in code per phone. Only a keyed hash of the code is stored; it lives 10 minutes.
CREATE TABLE sms_codes (
  phone          TEXT PRIMARY KEY,
  code_hash      TEXT,
  expires_at     INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,          -- wrong guesses on the current code
  sent_count     INTEGER NOT NULL DEFAULT 0,          -- codes sent in the current 24 h window (SMS cost cap)
  window_start   INTEGER NOT NULL,
  last_sent_at   INTEGER NOT NULL
);

-- Signed-in browsers. The cookie holds a random token; only its SHA-256 is stored.
CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('pro', 'admin')),
  subject      TEXT NOT NULL,                         -- pros.id, or the admin's email address
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX sessions_subject ON sessions (kind, subject);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Email sign-in links for the team (addresses listed in the ADMIN_EMAILS secret). Single use, 15 minutes.
CREATE TABLE admin_links (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
