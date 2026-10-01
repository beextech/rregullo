// /cregjistrohu?s=<id>&t=<signature>: the unsubscribe link in launch emails.
// GET asks first (so link scanners can't unsubscribe anyone); the button POSTs.
// Mail apps' one-click unsubscribe (RFC 8058) POSTs "List-Unsubscribe=One-Click" to the same URL.

import { readConfig } from '../server/config.js';
import { log, unsubscribe, verifyUnsubscribe } from '../server/subscribers.js';
import { esc, homeLink, page } from '../server/pages.js';

const bad = () => page({
  title: 'Lidhja nuk vlen', tone: 'error', heading: 'Kjo lidhje çregjistrimi nuk vlen.',
  body: 'Përdore lidhjen e plotë nga emaili ynë. Nëse problemi vazhdon, na shkruaj dhe të heqim nga lista.',
  action: homeLink,
}, 400);

export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;
  const s = q.get('s') || '', t = q.get('t') || '';
  const cfg = readConfig(env);
  if (!cfg.appSecret || !(await verifyUnsubscribe(cfg, s, t))) return bad();
  return page({
    title: 'Çregjistrohu',
    heading: 'Don me u çregjistru?',
    body: 'Nuk do të marrësh më email nga Rregullo, dhe adresa jote fshihet nga lista.',
    action: `<form class="notice-action" method="post" action="/cregjistrohu?s=${esc(encodeURIComponent(s))}&amp;t=${esc(t)}">
      <button class="btn" type="submit">Po, çregjistrohu</button>
    </form>`,
  });
}

export async function onRequestPost({ request, env }) {
  const q = new URL(request.url).searchParams;
  const s = q.get('s') || '', t = q.get('t') || '';
  const cfg = readConfig(env);
  const body = await request.text().catch(() => '');
  const oneClick = body.includes('List-Unsubscribe=One-Click');
  if (!cfg.db || !cfg.appSecret || !(await verifyUnsubscribe(cfg, s, t))) {
    return oneClick ? new Response('Invalid link', { status: 400 }) : bad();
  }
  try {
    await unsubscribe(cfg, s, Date.now());
  } catch (e) {
    log('unsubscribe_failed', { reason: e.message });
    return oneClick ? new Response('Try again', { status: 503 }) : page({
      title: 'Provo përsëri', tone: 'error', heading: 'Diçka nuk shkoi si duhet. Provo përsëri pas pak.', action: homeLink,
    }, 503);
  }
  if (oneClick) return new Response('Unsubscribed', { status: 200 });
  return page({
    title: 'U çregjistrove',
    heading: 'U çregjistrove.',
    body: 'Adresa jote u fshi nga lista e njoftimeve. Nuk do të marrësh më email prej nesh.',
    action: homeLink,
  });
}
