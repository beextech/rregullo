-- The Rregullo app, step 2: the mjeshtër dashboard. Times are Unix epoch milliseconds.

-- Photos: one profile photo and up to 12 work photos per mjeshtër. The image itself is in R2 (binding PHOTOS)
-- under foto/<id>.jpg and is served at /foto/<id>.jpg; this table says whose it is and in which order.
CREATE TABLE pro_photos (
  id          TEXT PRIMARY KEY,                       -- random UUID
  pro_id      TEXT NOT NULL REFERENCES pros (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('profile', 'work')),
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,             -- work photos are shown in this order, lowest first
  created_at  INTEGER NOT NULL
);
CREATE INDEX pro_photos_pro ON pro_photos (pro_id, kind, position);

-- What clients did on a mjeshtër's profile, counted per day. The public directory (step 4) adds to it;
-- the dashboard's Ballina shows the last 30 days. No client data: only the counts.
CREATE TABLE pro_stats_daily (
  pro_id    TEXT NOT NULL REFERENCES pros (id) ON DELETE CASCADE,
  day       TEXT NOT NULL,                            -- YYYY-MM-DD (UTC)
  views     INTEGER NOT NULL DEFAULT 0,               -- profile opened
  calls     INTEGER NOT NULL DEFAULT 0,               -- "Thirre" tapped
  whatsapp  INTEGER NOT NULL DEFAULT 0,
  viber     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pro_id, day)
);
