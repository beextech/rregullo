// Cloudflare Worker entry. Static files in dist/ are served by Workers static assets (the ASSETS binding);
// the dynamic routes reuse the handlers in functions/, which keep the Pages Functions signature.
// Mjeshtër photos (/foto/<id>.jpg) come from R2. The team admin's page (/admin/) is static; its API is /api/admin/*.
// The public directory (/kerko, /m/<name>-<handle>, /api/numero, /sitemap.xml) is in functions/drejtoria.js, and the
// clients' reviews (/api/vleresim, /vleresimi) in functions/vleresimi.js, and ads (/api/reklama, /r/<id>) in functions/reklama.js.

import * as subscribe from '../functions/api/subscribe.js';
import * as konfirmo from '../functions/konfirmo.js';
import * as cregjistrohu from '../functions/cregjistrohu.js';
import {
  dergo, dil, disponueshem, foto, fotoFshi, fotoRenditja, fshi, hyr, kodi, pergjigju, profili, raporto, une,
} from '../functions/api/mjeshtri.js';
import * as admin from '../functions/api/admin.js';
import * as drejtoria from '../functions/drejtoria.js';
import * as vleresimi from '../functions/vleresimi.js';
import * as reklama from '../functions/reklama.js';
import { servePhoto } from '../server/photos.js';

const ROUTES = {
  '/api/subscribe': subscribe,
  '/konfirmo': konfirmo,
  '/cregjistrohu': cregjistrohu,
  '/api/mjeshtri/kodi': kodi,
  '/api/mjeshtri/hyr': hyr,
  '/api/mjeshtri/une': une,
  '/api/mjeshtri/dil': dil,
  '/api/mjeshtri/profili': profili,
  '/api/mjeshtri/disponueshem': disponueshem,
  '/api/mjeshtri/dergo': dergo,
  '/api/mjeshtri/foto': foto,
  '/api/mjeshtri/foto/fshi': fotoFshi,
  '/api/mjeshtri/foto/renditja': fotoRenditja,
  '/api/mjeshtri/fshi': fshi,
  '/api/mjeshtri/pergjigju': pergjigju,
  '/api/mjeshtri/raporto': raporto,
  '/api/admin/lidhja': admin.lidhja,
  '/api/admin/hyr': admin.hyr,
  '/api/admin/une': admin.une,
  '/api/admin/dil': admin.dil,
  '/api/admin/mjeshtrit': admin.mjeshtrit,
  '/api/admin/mjeshtri': admin.mjeshtri,
  '/api/admin/vendim': admin.vendim,
  '/api/admin/profili': admin.profili,
  '/api/admin/foto': admin.foto,
  '/api/admin/foto/fshi': admin.fotoFshi,
  '/api/admin/shto': admin.shto,
  '/api/admin/fshi': admin.fshi,
  '/api/admin/vleresim': admin.vleresim,
  '/api/admin/reklamat': admin.reklamat,
  '/api/admin/reklamuesi': admin.reklamuesi,
  '/api/admin/reklamuesi/fshi': admin.reklamuesiFshi,
  '/api/admin/fushata': admin.fushata,
  '/api/admin/fushata/foto': admin.fushataFoto,
  '/api/admin/fushata/foto/hiq': admin.fushataFotoHiq,
  '/api/admin/fushata/fshi': admin.fushataFshi,
  '/api/admin/raporti': admin.raporti,
  '/kerko': drejtoria.kerko,
  '/api/numero': drejtoria.numero,
  '/sitemap.xml': drejtoria.sitemap,
  '/api/vleresim': vleresimi.dergo,
  '/vleresimi': vleresimi.lidhja,
  '/api/reklama': reklama.reklama,
};

const PHOTO_PATH = /^\/foto\/([^/]+)\.jpg$/;
const PROFILE_PATH = /^\/m\/([A-Za-z0-9-]{1,80})$/;
const AD_CLICK_PATH = /^\/r\/([A-Za-z0-9-]{1,64})$/;

function handlerFor(mod, method) {
  const m = method === 'HEAD' ? 'GET' : method;
  const named = mod[`onRequest${m.charAt(0)}${m.slice(1).toLowerCase()}`];
  return named || mod.onRequest || null;
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    const photo = PHOTO_PATH.exec(path);
    if (photo) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
      return servePhoto(env.PHOTOS, request, photo[1]);
    }
    const profile = PROFILE_PATH.exec(path);
    const click = !profile && AD_CLICK_PATH.exec(path);
    const mod = profile ? drejtoria.profili : click ? reklama.klik : ROUTES[path];
    if (!mod) return env.ASSETS.fetch(request);

    const handler = handlerFor(mod, request.method);
    if (!handler) {
      const allow = ['Get', 'Post'].filter((m) => mod[`onRequest${m}`]).map((m) => m.toUpperCase()).join(', ');
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: allow } });
    }
    const params = profile ? { slug: profile[1] } : click ? { id: click[1] } : {};
    const res = await handler({ request, env, waitUntil: ctx.waitUntil.bind(ctx), params });
    return request.method === 'HEAD' ? new Response(null, res) : res;
  },
};
