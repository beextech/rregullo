# rregullo.net: coming-soon page with launch-email signup

The public coming-soon page for Rregullo. Visitors can leave their email address to hear when Rregullo launches; the address only joins the list after they confirm it (double opt-in).

- **Front end:** static HTML, CSS and a little JavaScript, built from Rregullo identity 2.4.
- **Back end:** a Cloudflare Worker that serves the static files (Workers static assets) and the three signup routes, with a Cloudflare D1 (SQLite) database for the list.
- **Email:** sent through [Resend](https://resend.com) over plain HTTPS. There's no SDK.
- **Dependencies:** none at runtime. `wrangler` is the only dev dependency.

> **Status: built and tested locally, not yet deployed.** Every flow below passes against the real Functions and a local D1 database, with a mock email API standing in for Resend (`npm test`). Real email delivery has **not** been tested: that needs the Resend account and DNS records in [Setup](#setup). After deploying, run the [live check](#live-check-after-deploying).

## How it works

```
Visitor ──► form (email + consent) ──► POST /api/subscribe
                                         │ validate, honeypot, same-origin, rate limit
                                         ▼
                              D1: subscriber "pending" ──► Resend: "Konfirmo emailin" (link valid 48 h)
                                                                     │
Visitor clicks the link ──► /konfirmo?t=… (page) ──► POST /konfirmo ─┘
                                         ▼
                              D1: "confirmed" ──► Resend: note to LAUNCH_NOTIFICATION_EMAIL
                                         ▼
When Rregullo is live: scripts/send-launch.mjs ──► one email per confirmed subscriber, with unsubscribe link
Unsubscribe link ──► /cregjistrohu?s=…&t=… ──► address deleted, keyed hash kept to honour the unsubscribe
```

| Path | What it is |
|---|---|
| `/` | The page. The signup form is in the hero (`#lajmerimi`). |
| `/privatesia` | The privacy notice. It describes exactly what this code does. |
| `POST /api/subscribe` | Takes JSON from the page's script, or a plain form post when JavaScript is off. |
| `/konfirmo?t=<token>` | The confirmation link. GET only shows a page; the page posts the token, so link scanners can't confirm anyone. |
| `/cregjistrohu?s=<id>&t=<sig>` | The unsubscribe link. It asks before acting, and also accepts one-click unsubscribe from mail apps (RFC 8058). |

### What's stored

One row per address in `subscribers` (`migrations/0001_subscribers.sql`). Names, phone numbers and IP addresses are never stored.

| Column | Why |
|---|---|
| `email` | To send the confirmation and the launch email. Set to `NULL` on unsubscribe. |
| `email_hash` | A keyed HMAC of the address. Prevents duplicates and keeps an unsubscribe honoured after the address is deleted. |
| `status` | `pending`, `confirmed` or `unsubscribed` |
| `consent_version`, `consent_at` | Which consent wording was accepted (the text is in `server/config.js`), and when. |
| `confirmed_at`, `unsubscribed_at` | When each happened. |
| `confirm_token_hash`, `confirm_expires_at` | SHA-256 of the emailed token, never the token itself. Valid for 48 h, single-use. |
| `confirm_sent_count`, … | Resend limits: one email per 2 minutes, at most 3 per 24 h for each address. |
| `team_notify_status` | Whether the team note was sent, so a failed one is retried. |
| `launch_sent_at` | Set by the launch script, so a re-run never sends twice. |

`rate_events` holds a daily-rotating HMAC of the visitor's IP (never the IP itself) for 24 hours, to limit each IP to 6 signups per 10 minutes and 30 per day.

### Safeguards

**Form and API**
- **Validation:** checked on the server, with messages next to each field in the browser.
- **Consent:** the checkbox starts unchecked, and the server rejects any request without it.
- **No double sends:** the button is disabled while a request runs.
- **Honest success:** the success panel appears only after the server says the request was accepted. On a network failure, what the visitor typed stays in the form.
- **Bots:** a honeypot field that bots fill and people never see, plus the per-IP rate limit.
- **Cross-site posts:** refused, along with oversized bodies and wrong methods.
- **No list leaks:** the same answer comes back whether an address is new, pending or already confirmed, so nobody can find out who is on the list.

**Database and secrets**
- **Queries:** every query is a prepared statement with bound parameters.
- **Access:** the database is reachable only through the Functions' `DB` binding. There's no public export or admin endpoint.
- **Secrets:** they live only in Cloudflare's encrypted secrets and in a git-ignored `.dev.vars` locally. None are in the repo.

**Links and tokens**
- **Confirmation token:** 32 random bytes; only its hash is stored. URLs never contain the email address.
- **No leaks from the confirm page:** it sends `Referrer-Policy: no-referrer`, so the token never reaches another site.
- **Unsubscribe links:** signed with HMAC and compared in constant time.

**Logs and the browser**
- **Logs:** event names only, such as `confirm_email_sent`, with no addresses or tokens. The test suite checks this.
- **No tracking:** no cookies, analytics or third-party scripts. A strict Content Security Policy covers the page and the server-rendered pages.

### When something fails

- **The confirmation email can't be sent:** the pending record is kept and the visitor sees *Diçka nuk shkoi si duhet. Provo përsëri pas pak.* Submitting again sends a fresh link. Failed sends don't count towards the resend limit.
- **The team note can't be sent:** the record is marked `failed`, and the next request to the site retries it, up to 5 times.
- **The database is unavailable:** the visitor gets the same generic error, never a false success.

### Retention

Retention is enforced automatically: a cleanup runs in the background after signup and confirmation requests.

| Record | Kept for |
|---|---|
| Unconfirmed signup | 7 days after the last request |
| Confirmed subscriber | Until they unsubscribe, or 6 months after the launch email, then deleted |
| After unsubscribe | The address is deleted at once; the keyed hash is kept 12 months, then deleted |
| Rate-limit records | 24 hours |

If you change these, change `RETENTION` in `server/config.js` **and** the privacy notice (`src/privatesia.html`) together.

## Setup

These are the one-time steps, in order. Each one needs your accounts; I couldn't do them from here.

### 1. Cloudflare Worker and DNS for rregullo.net

The site deploys as a Cloudflare Worker named `rregullo` (`wrangler.toml`): `dist/` is served as static assets, and `worker/index.js` routes `/api/subscribe`, `/konfirmo` and `/cregjistrohu` to the handlers in `functions/`. Until the domain is connected it is reachable at `https://rregullo.<your-subdomain>.workers.dev`.

Quickest path, with an API token (Workers Scripts Edit, D1 Edit, Account Settings Read) in the environment:

```bash
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… RESEND_API_KEY=… LAUNCH_NOTIFICATION_EMAIL=… npm run deploy:auto
```

`scripts/deploy.mjs` creates the D1 database if needed, writes its id and the workers.dev `SITE_URL` into `wrangler.toml`, runs the migrations, builds, deploys, stores the secrets (generating `APP_SECRET` only if the Worker has none) and checks the live page. Commit `wrangler.toml` afterwards.

To deploy from your computer by hand: `npx wrangler login`, then steps 2 and 4 below, then `npm run deploy`. To deploy on every push instead, use **Workers & Pages > Create > Import a repository**, pick this repo, and set:
   - **Build command:** `npm run build`
   - **Deploy command:** `npx wrangler deploy`
   - **Build variable:** `NODE_VERSION` = `20`

   Builds of other branches (pull requests) run `npx wrangler preview`. The `[previews]` block in `wrangler.toml` gives those previews no database, variables or secrets, so a preview can never touch the real list; signup and sign-in answer with an error there. Previews also get no public URL while `preview_urls = false`.

The domain is connected through `routes` in `wrangler.toml`: `rregullo.net` and `www.rregullo.net` are Worker custom domains, so each deploy creates their DNS records and HTTPS certificates. The DNS zone is on Cloudflare (nameservers set at Namecheap). If a deploy fails with *"Hostname … already has externally managed DNS records"*, delete the A, AAAA and CNAME records for `@` and `www` under **rregullo.net > DNS > Records** (keep the MX and TXT email-forwarding records) and deploy again. `SITE_URL` is `https://rregullo.net`; note that `npm run deploy:auto` rewrites it to the workers.dev address.

### 2. Database (D1)

```bash
npx wrangler login
npx wrangler d1 create rregullo-launch --location=weur      # Western Europe
# paste the printed database_id into wrangler.toml
npm run db:migrate                                          # creates the tables in production
```

`wrangler.toml` binds it to the Worker as `DB`.

### 3. Email (Resend)

1. Create a Resend account and go to **Domains > Add domain > `rregullo.net`**. Use a send subdomain if Resend offers one; the default is fine.
2. Add the DNS records Resend shows (SPF/MX on `send.rregullo.net` and a DKIM TXT) in Cloudflare DNS, then click **Verify**.
3. Add a DMARC record if there's none: TXT `_dmarc.rregullo.net` with `v=DMARC1; p=none; rua=mailto:<your address>`. Tighten it later.
4. Create an API key with **Sending access** for that domain only.
5. The sender is set in `wrangler.toml` as `EMAIL_FROM = "Rregullo <njoftime@rregullo.net>"`. Change the mailbox name if you like; it must be on the verified domain. To have replies go somewhere real, set `EMAIL_REPLY_TO`.

Check Resend's current free-tier daily and monthly limits against the expected list size. If the list will exceed them, upgrade, or send the launch email through a campaign tool (see [Manage the list](#manage-the-list)).

### 4. Secrets and settings

Set these under **Worker > Settings > Variables and Secrets** (type **Secret**), or with `npx wrangler secret put <NAME>`:

| Name | Value |
|---|---|
| `APP_SECRET` | 32+ random characters. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Keep a copy in a password manager: the launch script needs it, and changing it later breaks existing unsubscribe links and duplicate detection. |
| `RESEND_API_KEY` | The key from step 3 |
| `LAUNCH_NOTIFICATION_EMAIL` | The team inbox for signup notes (the address you gave, set only as a secret so it never appears in the public repo). Without it, no notes are sent. |

Non-secret settings are in `wrangler.toml` `[vars]`:

| Name | Value |
|---|---|
| `SITE_URL` | The public address: the `workers.dev` URL while testing, `https://rregullo.net` once the domain is connected. Used to build every link in emails. It never comes from the request's Host header. |
| `EMAIL_FROM` | The sender, from step 3. |
| `LAUNCH_NOTIFY_ON` | `all` (set): a note for every signup request and every confirmation. `confirmed`: confirmations only. |

For the static page, in `site.config.json` or as build environment variables:

| Name | Value |
|---|---|
| `CONTACT_EMAIL` | **Set this before launch.** It's the contact for data requests in the privacy notice. The build warns while it's empty. |
| `INSTAGRAM_URL`, `FACEBOOK_URL`, `TIKTOK_URL`, `LINKEDIN_URL` | Official profiles, shown in the closing section only when set. |

### 5. Deploy

Run `npm run deploy` (build, then `wrangler deploy`), or push to the connected branch if you set up Git deploys. Secrets take effect without a redeploy.

## Live check after deploying

**Do this before telling anyone the form works:**

1. On the site (`SITE_URL`), sign up with an inbox you control. You should see *Edhe një hap! Kontrollo emailin për me e konfirmu adresën.*
2. The email *Konfirmo emailin për lansimin e Rregullo* arrives (check spam). In the email's headers, SPF and DKIM should show `pass`.
3. Click **Konfirmo emailin**. You should see *Emaili u konfirmua. Do të të lajmërojmë kur Rregullo të jetë gati.*
4. The team inbox gets two notes, both with the address masked: *Rregullo: kërkesë e re për njoftim* after step 1 and *Rregullo: regjistrim i ri i konfirmuar* after this step. Check Gmail's spam folder the first time and mark them "Not spam".
5. Click the same link again. You should see *Kjo lidhje nuk vlen më.*
6. Run `node scripts/send-launch.mjs --preview-to <your inbox>` (env as in [Launch day](#launch-day)), then click **Çregjistrohu** in the preview. You should see *U çregjistrove.* The preview's link matches nobody, so nothing changes.
7. Check the logs under **Worker > Observability > Logs**: they should show events like `confirm_email_sent` and `subscriber_confirmed`, and no addresses.

## Manage the list

Run these from this folder, after `npx wrangler login`:

```bash
# counts
npx wrangler d1 execute rregullo-launch --remote --command \
  "SELECT status, COUNT(*) AS n FROM subscribers GROUP BY status"

# confirmed addresses (to a local file; store it securely and delete it after use)
npx wrangler d1 execute rregullo-launch --remote --json --command \
  "SELECT email, confirmed_at FROM subscribers WHERE status = 'confirmed'" > confirmed.json

# someone asks to be removed (or withdraws consent by email): delete them completely
npx wrangler d1 execute rregullo-launch --remote --command \
  "DELETE FROM subscribers WHERE email = 'person@example.com'"
```

**Deleting someone:** a person can withdraw on their own with the unsubscribe link in every launch email. That deletes the address and keeps only the keyed hash. If they haven't confirmed, the record deletes itself after 7 days.

**Using a campaign tool:** to send the launch email through something like Brevo or Mailchimp instead, export only confirmed addresses as above, import them, and delete the export.
- **Suppression:** don't import anyone whose status is `unsubscribed`; their address is already gone.
- **No public export:** there's deliberately no public export endpoint.

## Launch day

`scripts/send-launch.mjs` sends the announcement. Each confirmed subscriber gets their own email (no shared recipients), with a personal unsubscribe link and `List-Unsubscribe` / `List-Unsubscribe-Post` headers. The template is `launchEmail()` in `server/templates.js`: it says Rregullo **is now available**, so it only goes out when that's true.

```bash
export APP_SECRET=… RESEND_API_KEY=… EMAIL_FROM="Rregullo <njoftime@rregullo.net>"
export LAUNCH_URL=https://rregullo.net/          # where "Hape Rregullo" points
node scripts/send-launch.mjs                                     # dry run: counts, masked sample
node scripts/send-launch.mjs --preview-to you@example.com        # one preview to yourself
node scripts/send-launch.mjs --send --i-confirm-rregullo-is-live # the real send
```

- **Safe to re-run:** recipients are marked as they go, so a re-run only sends to those not yet sent (including any that failed).
- **Pacing:** it sends at about 2 per second.

## Local development and tests

```bash
npm install
cp .dev.vars.example .dev.vars        # fill APP_SECRET; for no real email, set EMAIL_API_BASE (next line)
node scripts/mock-email.mjs &          # fake Resend on :8790; see what was "sent" at /_messages
npm run dev                            # build + local D1 migrations + wrangler dev on :8787
npm test                               # the full flow on :8789 with a fresh database and the mock
```

`npm test` checks:

- **Signup:**
  - a valid signup creates a pending record and sends a confirmation email to the normalised address
  - a missing email, a malformed one, or a missing consent is rejected
  - a duplicate signup gets the same answer, with no second row and no second email
  - the honeypot, the rate limit, cross-site posts, oversized bodies and wrong methods are all refused
- **Confirmation:**
  - GET doesn't confirm; POST confirms and notifies the team with the address masked
  - a reused, expired or made-up token is refused
- **Email content:** the confirmation email's copy and links.
- **Failures:**
  - a provider outage gives an error, keeps the record, and a retry delivers
  - a team-note outage is marked and retried
  - a database outage gives a generic error, never a false success
- **Unsubscribe:**
  - the page asks first
  - a tampered link is refused
  - the address is deleted and the hash kept
  - one-click unsubscribe works
  - signing up again after unsubscribing needs a new confirmation
- **Other:**
  - the no-JavaScript form works
  - the 7-day retention runs
  - the logs contain no addresses or tokens

The form itself (validation, the loading state, a double click sending only one request, the error state keeping the input, the success panel, phone layout and keyboard order) was checked in headless Chromium at 1440 px and 390 px.

## The page itself

**Brand assets, all from Rregullo identity 2.4:**
- **Logo:** inline SVG wordmark and level O.
- **Hero film:** the 2.4 web cut, muted and cropped to 4:3. MP4 is 0.27 MB on phones and 0.61 MB on desktop, with WebM as a fallback.
  - **Playback:** it plays once when visible, then hands off to the crisp SVG logo. It never loops, per the brand guide; *Shiko sërish* replays it.
  - **Fallbacks:** with reduced motion or no JavaScript, it shows the static logo and doesn't download the video.
- **Fonts and colours:** Schibsted Grotesk, hosted on the site under the SIL OFL; Ink, Paper and Vial lime.

**Files:**

```
src/                 static site (index.html, privatesia.html, site.css, site.js, notice.js, media, fonts, icons, email logo)
worker/index.js      Worker entry: static assets + routes to the handlers below
functions/           route handlers: api/subscribe.js, konfirmo.js, cregjistrohu.js
server/              shared back-end code: config, validation, crypto, D1 queries, email, templates, pages
migrations/          D1 schema
scripts/             build.mjs, test-flow.mjs, mock-email.mjs, send-launch.mjs
wrangler.toml        Worker + static assets + D1 + non-secret vars
.dev.vars.example    secret names for local development (no values)
site.config.json     domain, contact email, social links (public, non-secret)
```

## Games (/loja)

`/loja/` is the catalog of short Rregullo games; each game has its own route. All are `noindex` and stay out of the sitemap.

| Route | Source | What it is |
| --- | --- | --- |
| `/loja/` | `src/loja/index.html`, `catalog.css` | Catalog: one card per game |
| `/loja/ceshme-t-piki/` | `src/loja/ceshme-t-piki/index.html` + `src/loja/loja.js`, `loja.css` | Çeshme t’piki: close the tap, tighten the nut |
| `/loja/qite-n-zhive/` | `src/loja/qite-n-zhive/` | Qite n’zhivë!: opens on the whole logo, moves into the O (a spirit level, libelë) to play, and pulls back out to the finished logo on success. Bring the bubble (the zhivë) between the two lines and hold it ~2.7 s. Tilt on phones (the sensor permission is asked only after "Fillo"; the slope is read from gravity along the screen, calibrated from the starting position), slider/drag/arrow keys otherwise |

Shared sound effects (opt-in) live in `src/loja/sfx/`. The homepage teasers below the signup link straight to each game (`src/teaser.css`, `src/teaser.js`).

To add a game: create `src/loja/<slug>/index.html` (copy the head, header and sprite from an existing game), add one `<li class="game">` card to `src/loja/index.html`, and optionally a teaser row on the homepage. The build picks up every `index.html` under `src/loja/` for the stylesheet hash and the missing-file checks.

## Mjeshtër panel (/mjeshtri)

Steps 1 and 2 of the app ([implementation guide](https://claude.ai/code/artifact/51fbc9e3-0603-434c-9676-6f7f0b561ffa)). Mjeshtër sign in with their Kosovo mobile number and a 6-digit code sent by SMS; there is no password, and clients never sign in. Once signed in, a mjeshtër fills in a profile, adds photos and sends it for approval.

The page (`src/mjeshtri/`) has four tabs:
- **Ballina:** the profile's state (not sent, being checked, live, needs changes, suspended), the "Marr punë tani" switch, the checklist with "Dërgo për shqyrtim", and the last 30 days' calls, WhatsApp and Viber taps, profile views and reviews. The counts stay at zero until the public profiles (step 3) and reviews (step 4) exist.
- **Profili:** name, up to 5 trades, up to 10 of the 38 municipalities, a few sentences about the work, years of experience, an optional price note and WhatsApp/Viber on or off, with a preview of what clients will see.
- **Foto:** a profile photo and up to 12 work photos, in the order chosen. The phone shrinks each photo before it is sent (profile 800×800, work photos at most 1600 px), which also removes its location data.
- **Llogaria:** the number, signing out (here or on every phone) and deleting the account.

| Path | What it is |
|---|---|
| `POST /api/mjeshtri/kodi` | `{ phone, turnstile }`: checks the bot test, then sends a code by SMS |
| `POST /api/mjeshtri/hyr` | `{ phone, code }`: checks the code and sets the `rr_mjeshtri` cookie (HttpOnly, Secure, SameSite=Lax, 90 days) |
| `GET /api/mjeshtri/une` | Everything the dashboard shows, or 401 |
| `POST /api/mjeshtri/dil` | `{ all? }`: signs out, on every phone with `all: true` |
| `POST /api/mjeshtri/profili` | Saves the profile; invalid fields come back by name and nothing is saved |
| `POST /api/mjeshtri/disponueshem` | `{ available }`: the "Marr punë tani" switch |
| `POST /api/mjeshtri/dergo` | Sends the profile for approval (needs name, a trade, a municipality and a profile photo) |
| `POST /api/mjeshtri/foto?lloji=profili\|pune` | The JPEG itself as the body (at most 2 MB, 200–2048 px); a new profile photo replaces the old one |
| `POST /api/mjeshtri/foto/fshi` | `{ id }`: deletes a photo |
| `POST /api/mjeshtri/foto/renditja` | `{ ids }`: the order of the work photos |
| `POST /api/mjeshtri/fshi` | `{ confirm: 'FSHIJE' }`: deletes the account, its photos, counts and sessions |
| `GET /foto/<id>.jpg` | A photo, straight from R2, cached for a year (a changed photo always gets a new id) |

Every POST must come from this site, as JSON (or `image/jpeg` for photos), which a page elsewhere can't send without a CORS preflight that the API never answers.

Tables:
- `migrations/0002_mjeshtrit.sql`: `pros` (one row per mjeshtër, created as `draft` at first sign-in), `sms_codes` (the current code's keyed hash and the send counters) and `sessions` (SHA-256 of each cookie token).
- `migrations/0003_paneli.sql`: `pro_photos` (one row per photo; the image is in R2 as `foto/<id>.jpg`) and `pro_stats_daily` (counts per mjeshtër per day). Both are deleted with the mjeshtër. Never rebuild the `pros` table (only `ALTER TABLE … ADD COLUMN`): rebuilding it would delete these rows through the cascade.

Trades and municipalities are in `src/mjeshtri/catalog.js`.

**Profile states.** A new account is `draft`. "Dërgo për shqyrtim" makes it `pending`; the team then sets `approved`, `rejected` (with a note in `status_note`, shown on Ballina) or `suspended`. A mjeshtër can keep editing while pending or approved. A suspended one can still look, sign out and delete the account, but not edit, upload, send or switch availability. Until the admin screen exists (step 6), approve from the Cloudflare dashboard (**D1 > rregullo-launch > Console**): `UPDATE pros SET status = 'approved', approved_at = unixepoch() * 1000, updated_at = unixepoch() * 1000 WHERE phone = '+38344…';` To ask for changes instead: `SET status = 'rejected', status_note = 'Shto një foto ku të shihet fytyra.'`.

**Keeping SMS cheap and safe**
- Cloudflare Turnstile must pass before any SMS goes out, and only `+383 43–49` mobile numbers get one.
- One code per number per minute, 5 per number per 24 hours, 10 per network per hour and 20 per day.
- A code lives 10 minutes, is single-use and is thrown away after 5 wrong guesses. Only an HMAC of it is stored.
- The answer is the same whether or not a number already has an account. Logs carry event names only, never numbers or codes.
- A failed send isn't counted and leaves no usable code. Outside local development, the Worker refuses to send codes until the SMS and Turnstile secrets are set.

**Photos.** At most 60 uploads a day per mjeshtër. The server checks that each upload really is a JPEG of a sensible size, and stops reading any body that passes 2 MB. Photos are served with their own locked-down headers (`Content-Security-Policy: sandbox`, `nosniff`, same-site only). R2's free tier covers 10 GB, roughly 40,000 photos at these sizes.

**Privacy.** The "Paneli i mjeshtrit" part of the privacy notice (`/privatesia#mjeshtrit`, linked from the sign-in screen and from Llogaria) lists what the panel stores, how long, and who processes it (Cloudflare, Twilio). If you change `SIGNIN` in `server/signin.js`, the photo rules or the tables, change the notice too.

**Setup before it goes live**
1. **R2 (photo storage):** Cloudflare dashboard > **R2 Object Storage** > enable it (free up to 10 GB; Cloudflare asks for a card but charges nothing within the free tier). The next deploy creates the `rregullo-foto` bucket by itself. Until R2 is enabled, deploys of this version fail and the live site stays on the previous version.
2. **Database tables:** `npm run db:migrate` (or `npm run deploy:auto`) applies `0002` and `0003`. They only add tables, so the live site is unaffected.
3. **Turnstile:** Cloudflare dashboard > Turnstile > Add widget for `rregullo.net` (managed mode). Put the **site key** in `site.config.json` as `turnstileSiteKey` (it's public) and the **secret key** in the Worker: `npx wrangler secret put TURNSTILE_SECRET_KEY`.
4. **SMS (Twilio):** create the account, and check the price per SMS to Kosovo (+383) against a local gateway first. Register `Rregullo` as an alphanumeric sender ID (or buy a number, or use a Messaging Service). Then set `npx wrangler secret put TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`, and set `SMS_FROM` in `wrangler.toml` if it isn't `Rregullo`. To use another provider, replace `sendSms()` in `server/sms.js`; nothing else depends on Twilio.
5. Deploy.

Pull-request previews have no database or photo storage, so the panel answers with an error there.

**Locally,** with no SMS or Turnstile settings, `npm run dev` shows the code on the page instead of texting it (only when `SITE_URL` is `http://localhost`); photos are kept in a local R2 under `.wrangler/state`. `npm run test:app` runs the sign-in and dashboard checks against fake Twilio and Turnstile servers (`scripts/mock-email.mjs`); `npm test` runs them after the signup checks. They cover sessions, every endpoint's same-site and method checks, saving and validating the profile, uploads (wrong types, sizes, the 12-photo and 60-a-day limits, replacing and deleting from R2), photo caching headers, approval states, the availability switch, the 30-day counts, suspension, signing out everywhere and deleting an account. The screens were also walked through in headless Chromium at 360 px, 390 px and 1280 px.

## Before launch, please also

- **Native speaker check:** have someone from Kosovo read all the new copy:
  - the error messages
  - the confirm and unsubscribe pages
  - the privacy notice
  - the launch email, which I wrote and which wasn't in the brief
- **Legal review:** have the privacy notice reviewed. It describes this implementation accurately, but it doesn't claim compliance with any specific law, and it mentions Kosovo's Agency for Information and Privacy only as the place to complain.
- **Contact email:** set `CONTACT_EMAIL`.
- **Native speaker check for `/mjeshtri`:** the sign-in page, the four dashboard tabs, their error messages, the SMS text and the new "Paneli i mjeshtrit" part of the privacy notice.
