// POST /api/subscribe: the launch-notification form.
// JSON in and out for the page's JavaScript; a plain form post (no JavaScript) gets an HTML page back.

import { readConfig } from '../../server/config.js';
import { log, maintenance, notifyTeam, rateLimited, saveSignup } from '../../server/subscribers.js';
import { MESSAGES, validateSignup } from '../../server/validate.js';
import { esc, homeLink, page } from '../../server/pages.js';

const MAX_BODY = 4096;

function reply(asHtml, status, data) {
  if (asHtml) {
    if (data.ok) return page({ title: 'Faleminderit', heading: MESSAGES.accepted, action: homeLink }, status);
    const detail = data.errors ? Object.values(data.errors).join(' ') : data.message;
    return page({
      title: 'Provo përsëri', heading: 'Kërkesa nuk u pranua.', body: detail, tone: 'error',
      action: '<p class="notice-action"><a class="btn" href="/#lajmerimi">Kthehu te formulari</a></p>',
    }, status);
  }
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

function originHost(origin) {
  try { return new URL(origin).host; } catch { return null; }
}

export async function onRequestPost({ request, env, waitUntil }) {
  const ctype = request.headers.get('Content-Type') || '';
  const asHtml = !ctype.includes('application/json');

  // Same-site only: a cross-site page can't post this form on someone's behalf. Hosts are compared, not
  // schemes: a page opened over plain http:// posts with an http:// Origin once the browser has upgraded
  // the request itself to https://, and that is still this site.
  const origin = request.headers.get('Origin');
  if (origin && originHost(origin) !== new URL(request.url).host) {
    return reply(asHtml, 403, { ok: false, message: MESSAGES.generic });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) return reply(asHtml, 413, { ok: false, message: MESSAGES.generic });

  let fields = {};
  try {
    if (ctype.includes('application/json')) fields = JSON.parse(raw);
    else if (ctype.includes('application/x-www-form-urlencoded')) fields = Object.fromEntries(new URLSearchParams(raw));
    else return reply(true, 415, { ok: false, message: MESSAGES.generic });
  } catch {
    return reply(asHtml, 400, { ok: false, message: MESSAGES.generic });
  }
  if (!fields || typeof fields !== 'object') return reply(asHtml, 400, { ok: false, message: MESSAGES.generic });

  // Honeypot: people never see this field. Bots that fill it get an ordinary-looking answer and nothing happens.
  if (fields.company_site) {
    log('signup_honeypot');
    return reply(asHtml, 200, { ok: true, message: MESSAGES.accepted });
  }

  const { email, errors } = validateSignup(fields);
  if (Object.keys(errors).length) return reply(asHtml, 400, { ok: false, errors });

  const cfg = readConfig(env);
  // Saving a signup needs only the database and the secret; email settings matter only for the team notice.
  if (!cfg.db || !cfg.siteUrl || !cfg.appSecret || cfg.appSecret.length < 32) {
    log('config_missing', { missing: cfg.missing });
    return reply(asHtml, 503, { ok: false, message: MESSAGES.generic });
  }

  const now = Date.now();
  try {
    if (await rateLimited(cfg, request.headers.get('CF-Connecting-IP'), now)) {
      log('signup_rate_limited');
      return reply(asHtml, 429, { ok: false, message: MESSAGES.rateLimited });
    }
    const out = await saveSignup(cfg, email, now);
    waitUntil((async () => {
      if (out.notifyTeam && !cfg.missing.length) await notifyTeam(cfg, out.notifyTeam, 'confirmed', now);
      await maintenance(cfg, now);
    })().catch((e) => log('maintenance_failed', { reason: e.message })));
    return reply(asHtml, 200, { ok: true, message: MESSAGES.accepted });
  } catch (e) {
    log('signup_failed', { reason: e.message });
    return reply(asHtml, 500, { ok: false, message: MESSAGES.generic });
  }
}

export function onRequest() {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
}
