// Ads (step 6), the public side:
//   GET  /api/reklama?vendi=loja|paneli&zanati=a,b&komuna=c,d   one ad for a page drawn in the browser (the games,
//                                                                the mjeshtër's Ballina), or 204 when none fits
//   POST /api/reklama  { id, vendi }                            counts a view, once it is on screen; always 204
//   GET  /r/<id>?v=<vendi>                                      counts a click and goes on to the advertiser's link
// Search results and profiles draw their ad on the server (functions/drejtoria.js). The signed-in team is never counted.

import { ADS, adLink, countAd, pickAd } from '../server/ads.js';
import { currentAdmin, readAdminConfig } from '../server/admin.js';
import { crossSite, json, notAllowed, readJson } from '../server/http.js';
import { missingCoreConfig } from '../server/signin.js';
import { log } from '../server/subscribers.js';

const none = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter((x) => /^[a-z0-9-]{1,40}$/.test(x)).slice(0, 10);

function setup(env) {
  const cfg = readAdminConfig(env);
  return missingCoreConfig(cfg).length ? null : cfg;
}

export const reklama = {
  async onRequestGet({ request, env }) {
    const url = new URL(request.url);
    const slot = url.searchParams.get('vendi');
    // Search and profile ads come with the page itself.
    if (slot !== 'loja' && slot !== 'paneli') return none();
    const cfg = setup(env);
    if (!cfg) return none();
    try {
      const ad = await pickAd(cfg, slot, { trades: list(url.searchParams.get('zanati')), towns: list(url.searchParams.get('komuna')) }, Date.now());
      return ad ? json(200, { ok: true, ad }, { 'Cache-Control': 'no-store' }) : none();
    } catch (e) {
      log('ad_error', { reason: e.message });
      return none();
    }
  },
  async onRequestPost({ request, env }) {
    if (crossSite(request)) return none();
    const input = await readJson(request);
    if (input.error) return none();
    const { id, vendi } = input.data;
    if (typeof id !== 'string' || !ADS.slots.includes(vendi)) return none();
    const cfg = setup(env);
    if (!cfg) return none();
    try {
      const now = Date.now();
      if (await currentAdmin(cfg, request, now)) return none();
      await countAd(cfg, id, vendi, 'views', request.headers.get('CF-Connecting-IP'), now);
    } catch (e) {
      log('ad_error', { reason: e.message });
    }
    return none();
  },
  onRequest: notAllowed('GET, HEAD, POST'),
};

export const klik = {
  async onRequestGet({ request, env, params }) {
    const go = (to) => new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
    const cfg = setup(env);
    if (!cfg) return go('/');
    try {
      const link = await adLink(cfg, params.id);
      if (!link) return go('/');
      const slot = new URL(request.url).searchParams.get('v');
      const now = Date.now();
      if (ADS.slots.includes(slot) && !(await currentAdmin(cfg, request, now))) {
        await countAd(cfg, params.id, slot, 'clicks', request.headers.get('CF-Connecting-IP'), now);
      }
      return go(link);
    } catch (e) {
      log('ad_error', { reason: e.message });
      return go('/');
    }
  },
  onRequest: notAllowed('GET, HEAD'),
};
