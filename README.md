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

To deploy from your computer: `npx wrangler login`, then steps 2 and 4 below, then `npm run deploy`. To deploy on every push instead, use **Workers & Pages > Create > Import a repository**, pick this repo, and set:
   - **Build command:** `npm run build`
   - **Deploy command:** `npx wrangler deploy`
   - **Build variable:** `NODE_VERSION` = `20`

Connecting the domain, when you're ready (`rregullo.net` is still on Namecheap's parking address, `162.255.119.6`):

1. In Cloudflare: **Add a site > rregullo.net** (the Free plan is enough). At Namecheap, under **Domain > Nameservers > Custom DNS**, enter the two nameservers Cloudflare gives you. The switch can take a few hours.
2. Set `SITE_URL` in `wrangler.toml` to `https://rregullo.net` and deploy again, so email links point at the domain.
3. Under **Worker > Settings > Domains & Routes**, add `rregullo.net` and `www.rregullo.net` as custom domains. Cloudflare issues HTTPS certificates automatically.
4. Under **SSL/TLS**: set the mode to **Full (strict)** and turn on **Always Use HTTPS**.
5. Redirect `www` to the bare domain, with a Redirect Rule from `www.rregullo.net/*` to `https://rregullo.net/${1}`, status 301.

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

## Before launch, please also

- **Native speaker check:** have someone from Kosovo read all the new copy:
  - the error messages
  - the confirm and unsubscribe pages
  - the privacy notice
  - the launch email, which I wrote and which wasn't in the brief
- **Legal review:** have the privacy notice reviewed. It describes this implementation accurately, but it doesn't claim compliance with any specific law, and it mentions Kosovo's Agency for Information and Privacy only as the place to complain.
- **Contact email:** set `CONTACT_EMAIL`.
