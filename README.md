# Rregullo: coming-soon website

The public coming-soon page for Rregullo. It's a static site with no dependencies: plain HTML, CSS and a little JavaScript, plus a small Node build script that fills in the domain and social links.

Every brand asset comes from **Rregullo identity 2.4**:

| On the page | Source in the identity pack |
|---|---|
| Wordmark, the level O and the small logo (inline SVG) | `01-logo/svg`, `02-symbol-o/svg` (the paths are copied exactly) |
| Hero film | `05-motion/rregullo-film_web_1920x1080_silent.mp4`, cropped to 4:3 and re-encoded |
| Favicons, touch icon, manifest icons | `04-app-and-web` |
| Share image | `04-app-and-web/og-image_1200x630.png` |
| Colours (Ink, Paper, Vial lime) and Schibsted Grotesk | The identity README |

## What's on the page

1. **Header:** the small logo and a status pill that says *Së shpejti në Kosovë*.
2. **Hero:** the eyebrow, the headline, the supporting line, the follow button (shown only once the Instagram URL is set) and the brand film.
3. **Çka është Rregullo?:** what the platform is for, plus a line saying it is still being built.
4. **Si ka me funksionu:** the three planned steps, under the label *Kur të jetë gati*, so nobody reads them as a live service.
5. **Emri dhe shenja:** the level O and what it means, with the vision statement.
6. **Finale:** the logo, *Ki diçka me rregullu? Rregullo po vjen. Na ndiq për lansimin.*, and the social links.

The page makes no claims about launch dates, numbers, verification, prices or bookings. It never says *link në bio*, *regjistrohu tash* or *gjeje mjeshtrin tani*.

## The hero film

- **Format:** the 2.4 web cut, muted, cropped to 4:3. The first frame of the source is a render glitch (a black silhouette), so it is trimmed and replaced with a short fade from Ink.
  - **MP4 (H.264), served first:** 0.27 MB on phones, 0.61 MB on desktop.
  - **WebM (VP9):** used only by browsers that can't play the MP4.
- **When it plays:** once, the first time the stage is at least half on screen. It pauses when scrolled away or when the tab is hidden.
- **Hand-off:** at the end the video gives way to the inline SVG logo, which sits exactly where the film's last frame draws the logo (measured from the frame). The resting logo is vector and stays crisp at any size. A *Shiko sërish* button replays the film.
- **No loop:** the brand guidelines say the film plays once and never loops. To loop it anyway, add `loop` to the `<video>` in `src/index.html`.
- **No layout shift:** the stage is a fixed 4:3 box.
- **Fallbacks:** each of these shows the static SVG logo and never downloads the video:
  - reduced motion is on
  - JavaScript is off
  - autoplay is refused (for example in iOS Low Power Mode or with Data Saver); there *Shiko sërish* starts the film
  - the video fails to load
- **Sound:** none. The page never plays audio.

## Configure

Set these in `site.config.json`, or as environment variables (environment variables win):

| Setting | Env variable | What it does |
|---|---|---|
| `siteUrl` | `SITE_URL` | The live domain, e.g. `https://rregullo.com`. Adds the canonical URL, an absolute share-image URL and `sitemap.xml`. |
| `social.instagram` | `INSTAGRAM_URL` | The official profile, e.g. `https://www.instagram.com/<handle>/`. Turns on the hero button *Na ndiq për lansimin* and the Instagram link in the finale. |
| `social.facebook`, `social.tiktok`, `social.linkedin` | `FACEBOOK_URL`, `TIKTOK_URL`, `LINKEDIN_URL` | Optional extra profiles, shown only when set. |

The build refuses a social URL that isn't https, isn't on that network's own domain, or points at the network's home page. With no URL set, nothing is linked: there are no placeholders and no dead buttons.

## Build and preview

Requires Node 18 or later. There is nothing to install.

```bash
npm run build                      # writes dist/
npm run preview                    # builds, then serves dist/ at http://localhost:8788
INSTAGRAM_URL=https://www.instagram.com/<handle>/ SITE_URL=https://<domain> npm run build
```

The build checks that no template markers are left and that every local file the pages reference exists.

## Deploy to Cloudflare Pages

**Option A: from Git (recommended)**

1. Push this folder to a GitHub repository (for example `rregullo-site`).
2. In Cloudflare, open **Workers & Pages > Create > Pages > Connect to Git** and choose the repository.
3. Set the build settings:
   - **Framework preset:** None
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Environment variables (Production):** `SITE_URL` = your domain with https; `INSTAGRAM_URL` = the official profile once confirmed; `NODE_VERSION` = `20`
4. Click **Save and Deploy**. The site goes live at `https://<project>.pages.dev`.
5. Add the domain under **Custom domains > Set up a custom domain**. HTTPS is issued automatically. If the domain's DNS is already on Cloudflare, the record is created for you; otherwise, add the CNAME record Cloudflare shows you.
6. When the Instagram URL is confirmed later, add or change `INSTAGRAM_URL` and redeploy (**Deployments > Retry deployment**). No code change is needed.

**Option B: direct upload, without Git**

```bash
SITE_URL=https://<domain> INSTAGRAM_URL=https://www.instagram.com/<handle>/ npm run build
npx wrangler pages deploy dist --project-name rregullo
```

You can also drag the `dist` folder into **Workers & Pages > Create > Pages > Upload assets**.

**What Cloudflare picks up from `dist/`**

- **`_headers`:** security headers and caching.
  - **Content Security Policy:** self-hosted only. There are no third-party scripts, fonts or trackers.
  - **Cache:** CSS and JS are cached for a year; their URLs carry a content hash, so a change always reaches visitors.
- **`404.html`:** the branded not-found page.

## Checks before going live

**Verified while building (headless Chromium):**

- Desktop at 1440 px, tablet at 820 px and phones at 390 px and 320 px, with no horizontal overflow.
- The film plays and hands off to the SVG logo, and the replay button works.
- The reduced-motion and no-JavaScript versions show the logo and never download the video.
- No console errors.

**Still to check after deploying:**

- [ ] Open the live URL on a real iPhone and Android phone: the film autoplays muted and lands on the logo.
- [ ] Paste the URL into the [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug/) and check the share card.
- [ ] Have a native speaker from Kosovo read the copy aloud. In particular, check *libelë* (the spirit level), *Si ka me funksionu* and *Kur të jetë gati*, which are new on this page.

## Files

```
src/                 the site (edit here)
  index.html         page; the brand SVGs are in the sprite at the bottom
  site.css           styles: brand tokens at the top
  site.js            film playback and the scroll reveals
  media/             film (MP4 + WebM, 720 and 1200 px), poster, share image
  fonts/             Schibsted Grotesk (variable, self-hosted) and its licence (SIL OFL 1.1)
  icons/             favicons and app icons from the identity pack
  _headers           Cloudflare Pages headers
  404.html
scripts/build.mjs    builds src/ into dist/
site.config.json     domain and social links
```
