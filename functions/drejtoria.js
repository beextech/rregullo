// The public directory's routes (step 4):
//   GET  /kerko?zanati=&komuna=&faqja=   search results, rendered on the server
//   GET  /m/<name>-<handle>              one mjeshtër's profile (a stale name part redirects to the current one)
//   POST /api/numero  { m, lloji }       counts a profile view or a tap on Thirre, WhatsApp or Viber; a tap on an
//                                        approved profile also gets { receipt }, which "Si shkoi?" needs to review
//   GET  /sitemap.xml                    the static sitemap, plus /kerko and every approved profile once the directory is open
// Until DIRECTORY_OPEN is "1" the pages show "coming soon" to everyone but the signed-in team, and nothing is counted.

import { currentAdmin, readAdminConfig } from '../server/admin.js';
import {
  countTap, directoryOpen, receiptFor, handleFromSlug, loadPublicProfile, readSearch, search, sitemapEntries,
} from '../server/directory.js';
import { profilePage, searchPage } from '../server/directory-pages.js';
import { esc, homeLink, page } from '../server/pages.js';
import { crossSite, json, notAllowed, readJson } from '../server/http.js';
import { currentPro, missingCoreConfig, signinMaintenance } from '../server/signin.js';
import { log } from '../server/subscribers.js';

const unavailable = () => page({
  title: 'Gabim', tone: 'error',
  heading: 'Diçka shkoi keq.',
  body: 'Provo përsëri pas pak.',
  action: homeLink,
}, 503);

const comingSoon = () => page({
  title: 'Së shpejti',
  heading: 'Lista e mjeshtrave hapet së shpejti.',
  body: 'Lëre emailin në faqen kryesore dhe të lajmërojmë sapo të hapet.',
  action: '<p class="notice-action"><a class="btn" href="/#lajmerimi">Më lajmëroni</a></p>',
});

const notFound = () => page({
  title: 'Profili nuk u gjet', tone: 'error',
  heading: 'Ky profil nuk u gjet.',
  body: 'Mund të jetë hequr, ose adresa është shkruar gabim.',
  action: '<p class="notice-action"><a class="btn" href="/kerko">Kërko mjeshtër</a></p>',
}, 404);

/**
 * Who may see the directory: everyone once it is open; before that, only the signed-in team (as a preview).
 * @returns {Promise<{ cfg, preview: boolean } | { response: Response }>}
 */
async function access(env, request, now) {
  const cfg = readAdminConfig(env);
  if (missingCoreConfig(cfg).length) {
    log('config_missing', { missing: missingCoreConfig(cfg) });
    return { response: unavailable() };
  }
  if (directoryOpen(env)) return { cfg, preview: false };
  if (await currentAdmin(cfg, request, now)) return { cfg, preview: true };
  return { response: comingSoon() };
}

export const kerko = {
  async onRequestGet({ request, env }) {
    try {
      const now = Date.now();
      const a = await access(env, request, now);
      if (a.response) return a.response;
      const s = readSearch(new URL(request.url));
      const r = await search(a.cfg, s, now);
      return searchPage(a.cfg.siteUrl, s, r, { preview: a.preview });
    } catch (e) {
      log('directory_error', { reason: e.message });
      return unavailable();
    }
  },
  onRequest: notAllowed('GET, HEAD'),
};

export const profili = {
  async onRequestGet({ request, env, params }) {
    try {
      const now = Date.now();
      const a = await access(env, request, now);
      if (a.response) return a.response;
      const handle = handleFromSlug(params.slug.toLowerCase());
      const p = handle && await loadPublicProfile(a.cfg, handle);
      if (!p) return notFound();
      if (`/m/${params.slug}` !== p.path) {
        return new Response(null, { status: 301, headers: { Location: p.path, 'Cache-Control': 'no-cache' } });
      }
      return profilePage(a.cfg.siteUrl, p, { preview: a.preview });
    } catch (e) {
      log('directory_error', { reason: e.message });
      return unavailable();
    }
  },
  onRequest: notAllowed('GET, HEAD'),
};

const counted = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

export const numero = {
  // 204, counted or not, so a caller learns nothing about what was counted. A tap on an approved profile answers 200
  // with a receipt instead (the profile is public anyway); never for the team or the mjeshtër's own profile.
  async onRequestPost({ request, env, waitUntil }) {
    if (crossSite(request)) return counted();
    const input = await readJson(request);
    if (input.error || !directoryOpen(env)) return counted();
    const { m, lloji } = input.data;
    if (typeof m !== 'string' || typeof lloji !== 'string') return counted();
    const cfg = readAdminConfig(env);
    if (missingCoreConfig(cfg).length) return counted();
    try {
      const now = Date.now();
      // The team and the mjeshtër looking at their own profile don't count.
      if (await currentAdmin(cfg, request, now)) return counted();
      const pro = await currentPro(cfg, request, now);
      if (pro && pro.handle === m) return counted();
      await countTap(cfg, m, lloji, request.headers.get('CF-Connecting-IP'), now);
      // Now and then, clear the day-old records the counting leaves behind.
      if (Math.random() < 0.02) waitUntil(signinMaintenance(cfg, now).catch((e) => log('maintenance_failed', { reason: e.message })));
      const receipt = await receiptFor(cfg, m, lloji, now);
      if (receipt) return json(200, { ok: true, receipt });
    } catch (e) {
      log('tap_error', { reason: e.message });
    }
    return counted();
  },
  onRequest: notAllowed('POST'),
};

export const sitemap = {
  async onRequestGet({ request, env }) {
    const base = await env.ASSETS.fetch(new Request(new URL('/sitemap.xml', request.url)));
    if (!base.ok || !directoryOpen(env)) return base;
    const cfg = readAdminConfig(env);
    if (missingCoreConfig(cfg).length) return base;
    try {
      const entries = await sitemapEntries(cfg);
      const urls = [`  <url><loc>${esc(cfg.siteUrl)}/kerko</loc></url>`, ...entries.map((e) => `  <url><loc>${esc(cfg.siteUrl + e.path)}</loc>${
        e.changed ? `<lastmod>${new Date(e.changed).toISOString().slice(0, 10)}</lastmod>` : ''}</url>`)];
      const xml = (await base.text()).replace('</urlset>', `${urls.join('\n')}\n</urlset>`);
      return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
    } catch (e) {
      log('directory_error', { reason: e.message });
      return base;
    }
  },
  onRequest: notAllowed('GET, HEAD'),
};
