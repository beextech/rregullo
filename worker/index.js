// Cloudflare Worker entry. Static files in dist/ are served by Workers static assets (the ASSETS binding);
// the three dynamic routes reuse the handlers in functions/, which keep the Pages Functions signature.

import * as subscribe from '../functions/api/subscribe.js';
import * as konfirmo from '../functions/konfirmo.js';
import * as cregjistrohu from '../functions/cregjistrohu.js';

const ROUTES = {
  '/api/subscribe': subscribe,
  '/konfirmo': konfirmo,
  '/cregjistrohu': cregjistrohu,
};

function handlerFor(mod, method) {
  const m = method === 'HEAD' ? 'GET' : method;
  const named = mod[`onRequest${m.charAt(0)}${m.slice(1).toLowerCase()}`];
  return named || mod.onRequest || null;
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    const mod = ROUTES[path];
    if (!mod) return env.ASSETS.fetch(request);

    const handler = handlerFor(mod, request.method);
    if (!handler) {
      const allow = ['Get', 'Post'].filter((m) => mod[`onRequest${m}`]).map((m) => m.toUpperCase()).join(', ');
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: allow } });
    }
    const res = await handler({ request, env, waitUntil: ctx.waitUntil.bind(ctx), params: {} });
    return request.method === 'HEAD' ? new Response(null, res) : res;
  },
};
