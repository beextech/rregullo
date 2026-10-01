// /konfirmo?t=<token>: the link in the confirmation email.
// GET only shows a page; the confirmation itself is a POST, which the page's script sends right away
// (or the visitor presses the button without JavaScript). Link scanners that fetch the URL can't confirm.

import { readConfig } from '../server/config.js';
import { confirmToken, log, maintenance, notifyTeam } from '../server/subscribers.js';
import { esc, homeLink, page, signupLink } from '../server/pages.js';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const invalid = () => page({
  title: 'Lidhja nuk vlen', tone: 'error',
  heading: 'Kjo lidhje nuk vlen më.',
  body: 'Mund të jetë përdorur tashmë ose të jetë kopjuar gabim. Nëse e ke konfirmuar emailin, s’ke nevojë me bë asgjë tjetër.',
  action: homeLink,
}, 400);

export function onRequestGet({ request }) {
  const t = new URL(request.url).searchParams.get('t') || '';
  if (!TOKEN.test(t)) return invalid();
  return page({
    title: 'Konfirmo emailin',
    heading: 'Po e konfirmojmë emailin…',
    body: 'Nëse kjo faqe nuk ndryshon, shtyp butonin.',
    action: `<form class="notice-action" method="post" action="/konfirmo" data-autosubmit>
      <input type="hidden" name="t" value="${esc(t)}">
      <button class="btn" type="submit">Konfirmo emailin</button>
    </form>`,
    script: '/notice.js',
  });
}

export async function onRequestPost({ request, env, waitUntil }) {
  // No Origin check here: the page uses no-referrer (so the token never leaks), which makes browsers send
  // "Origin: null". The single-use token is what authorises the confirmation.
  const form = await request.formData().catch(() => null);
  const t = form && form.get('t');
  if (typeof t !== 'string' || !TOKEN.test(t)) return invalid();

  const cfg = readConfig(env);
  const error = () => page({
    title: 'Provo përsëri', tone: 'error', heading: 'Diçka nuk shkoi si duhet. Provo përsëri pas pak.',
    action: `<form class="notice-action" method="post" action="/konfirmo"><input type="hidden" name="t" value="${esc(t)}"><button class="btn" type="submit">Provo përsëri</button></form>`,
  }, 503);
  if (!cfg.db || !cfg.siteUrl) { log('config_missing', { missing: cfg.missing }); return error(); }

  const now = Date.now();
  try {
    const out = await confirmToken(cfg, t, now);
    if (out.result === 'confirmed') {
      if (!cfg.missing.length) {
        waitUntil((async () => { await notifyTeam(cfg, out.id, 'confirmed', now); await maintenance(cfg, now); })()
          .catch((e) => log('maintenance_failed', { reason: e.message })));
      }
      return page({
        title: 'Emaili u konfirmua',
        heading: 'Emaili u konfirmua. Do të të lajmërojmë kur Rregullo të jetë gati.',
        action: homeLink,
      });
    }
    if (out.result === 'expired') {
      return page({
        title: 'Lidhja ka skaduar', tone: 'error',
        heading: 'Kjo lidhje ka skaduar.',
        body: 'Lidhjet e konfirmimit vlejnë 48 orë. Shkruaje emailin sërish dhe të dërgojmë një lidhje të re.',
        action: signupLink,
      }, 410);
    }
    return invalid();
  } catch (e) {
    log('confirm_failed', { reason: e.message });
    return error();
  }
}
