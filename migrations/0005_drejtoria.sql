-- The Rregullo app, step 4: the public directory (/kerko and /m/<name>). Times are Unix epoch milliseconds.

-- The short public id in a profile's address, /m/<name>-<handle>. It never changes, so links keep working when the
-- name does (the name part is only for people and Google, and a stale one redirects). Given at approval; the rows
-- that exist already get one here.
ALTER TABLE pros ADD COLUMN handle TEXT;
UPDATE pros SET handle = lower(hex(randomblob(5))) WHERE handle IS NULL;
CREATE UNIQUE INDEX pros_handle ON pros (handle);
