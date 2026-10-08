-- The Rregullo app, step 6: ads from companies that sell repair products. Times are Unix epoch milliseconds,
-- days are YYYY-MM-DD in UTC (like pro_stats_daily).

-- A company that advertises. The contact is for the team only and never shown.
CREATE TABLE advertisers (
  id          TEXT PRIMARY KEY,                       -- random UUID
  name        TEXT NOT NULL,                          -- shown under each of its ads
  contact     TEXT NOT NULL DEFAULT '',               -- who to talk to, phone or email: the team's note
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- One ad: where it shows (slots), for which trades and towns (an empty list means all), and when.
CREATE TABLE campaigns (
  id             TEXT PRIMARY KEY,                    -- random UUID; also in the /r/<id> click address
  advertiser_id  TEXT NOT NULL REFERENCES advertisers (id) ON DELETE CASCADE,
  title          TEXT NOT NULL,                       -- the ad's text (and the image's alt text)
  link           TEXT NOT NULL,                       -- https:// address a click goes to
  image_id       TEXT,                                -- a JPEG in R2 as foto/<id>.jpg, served at /foto/<id>.jpg; optional
  trades         TEXT NOT NULL DEFAULT '[]',          -- JSON list of trade slugs; [] = every trade
  towns          TEXT NOT NULL DEFAULT '[]',          -- JSON list of municipality slugs; [] = all of Kosovo
  slots          TEXT NOT NULL DEFAULT '[]',          -- JSON subset of kerko, profili, loja, paneli
  starts_on      TEXT NOT NULL,                       -- first day shown
  ends_on        TEXT NOT NULL,                       -- last day shown
  active         INTEGER NOT NULL DEFAULT 1,          -- the team's on/off switch
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX campaigns_advertiser ON campaigns (advertiser_id);
CREATE INDEX campaigns_live ON campaigns (active, starts_on, ends_on);

-- Views and clicks per ad, slot and day. Each is counted once per network address per day (keyed hashes in
-- rate_events, deleted after a day), so the report shows people, not page reloads.
CREATE TABLE ad_stats_daily (
  campaign_id  TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  day          TEXT NOT NULL,
  slot         TEXT NOT NULL CHECK (slot IN ('kerko', 'profili', 'loja', 'paneli')),
  views        INTEGER NOT NULL DEFAULT 0,
  clicks       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, day, slot)
);
