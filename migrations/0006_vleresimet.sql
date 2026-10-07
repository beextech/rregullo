-- The Rregullo app, step 5: reviews. Times are Unix epoch milliseconds.
-- Never rebuild `pros` here: its photos, counts, history and now reviews hang on it with ON DELETE CASCADE.

-- One row per review. A client can only review after tapping Thirre, WhatsApp or Viber on that mjeshtër (the tap's
-- signed receipt), 12 hours to 60 days after the tap, and the review only shows once confirmed through a link
-- sent to their email. The address itself is kept only until then; after that only a keyed hash stays, so the
-- same address reviewing the same mjeshtër again replaces its review instead of adding one.
CREATE TABLE reviews (
  id             TEXT PRIMARY KEY,                     -- random UUID
  pro_id         TEXT NOT NULL REFERENCES pros (id) ON DELETE CASCADE,
  receipt        TEXT NOT NULL,                        -- the tap receipt's random part: one receipt, one review
  tapped_at      INTEGER NOT NULL,                     -- when the tap happened, from the receipt
  stars          INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment        TEXT NOT NULL DEFAULT '',
  author         TEXT NOT NULL DEFAULT '',             -- the name the client chose to show, optional
  email          TEXT,                                 -- only until confirmed (to send the link), then NULL
  email_hash     TEXT NOT NULL,                        -- hmac(APP_SECRET, 'review-email', address)
  token_hash     TEXT NOT NULL UNIQUE,                 -- SHA-256 of the emailed link's token (confirms, later deletes)
  status         TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (status IN ('unconfirmed', 'visible', 'hidden')),
  reply          TEXT NOT NULL DEFAULT '',             -- the mjeshtër's one reply
  replied_at     INTEGER,
  reported_at    INTEGER,                              -- the mjeshtër reported it; the team keeps or hides it
  report_reason  TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  confirmed_at   INTEGER
);
CREATE INDEX reviews_pro ON reviews (pro_id, status, confirmed_at);
CREATE INDEX reviews_email ON reviews (pro_id, email_hash);
CREATE INDEX reviews_receipt ON reviews (receipt);
CREATE INDEX reviews_reported ON reviews (reported_at) WHERE reported_at IS NOT NULL;
CREATE INDEX reviews_unconfirmed ON reviews (status, created_at);

-- The team's history gains the review decisions. SQLite can't change a CHECK in place, so admin_log is rebuilt
-- (nothing references it; its rows are copied over unchanged).
CREATE TABLE admin_log_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pro_id       TEXT NOT NULL REFERENCES pros (id) ON DELETE CASCADE,
  at           INTEGER NOT NULL,
  admin        TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('created', 'profile', 'photo', 'approve', 'reject', 'suspend',
                                                'unsuspend', 'verify', 'unverify', 'seen', 'deleted',
                                                'review_keep', 'review_hide', 'review_show')),
  note         TEXT NOT NULL DEFAULT '',
  public_note  TEXT NOT NULL DEFAULT ''
);
INSERT INTO admin_log_new (id, pro_id, at, admin, action, note, public_note)
  SELECT id, pro_id, at, admin, action, note, public_note FROM admin_log;
DROP TABLE admin_log;
ALTER TABLE admin_log_new RENAME TO admin_log;
CREATE INDEX admin_log_pro ON admin_log (pro_id, at);
