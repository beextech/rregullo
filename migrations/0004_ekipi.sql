-- The Rregullo app, step 3: the team admin at /admin. Times are Unix epoch milliseconds.
-- Never rebuild `pros` here: its photos, counts and history hang on it with ON DELETE CASCADE.

-- Sign-in links sent to team addresses by email. Only the SHA-256 of the link's token and a keyed hash of its
-- 6-digit code are stored; a link works for 15 minutes, once. Rows are deleted a day after they were made.
CREATE TABLE admin_links (
  token_hash  TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,                          -- hmac(APP_SECRET, 'admin-code', email|code)
  email       TEXT NOT NULL,                          -- lowercased, one of ADMIN_EMAILS when it was sent
  attempts    INTEGER NOT NULL DEFAULT 0,             -- wrong codes; at 5 the link's code no longer works
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX admin_links_email ON admin_links (email, created_at);

-- Who in the team changed what on which mjeshtër, and why. Goes with the mjeshtër's row; a suspended number that
-- keeps its bare row after deletion keeps its history too.
CREATE TABLE admin_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pro_id       TEXT NOT NULL REFERENCES pros (id) ON DELETE CASCADE,
  at           INTEGER NOT NULL,
  admin        TEXT NOT NULL,                         -- the team member's email address
  action       TEXT NOT NULL CHECK (action IN ('created', 'profile', 'photo', 'approve', 'reject', 'suspend',
                                                'unsuspend', 'verify', 'unverify', 'seen', 'deleted')),
  note         TEXT NOT NULL DEFAULT '',              -- for the team only; the mjeshtër never sees it
  public_note  TEXT NOT NULL DEFAULT ''               -- the reason shown to the mjeshtër (reject, suspend)
);
CREATE INDEX admin_log_pro ON admin_log (pro_id, at);

-- When the mjeshtër (or the team) last changed the profile or its photos. An approved profile with
-- edited_at > approved_at has changed since the team looked at it.
ALTER TABLE pros ADD COLUMN edited_at INTEGER;
