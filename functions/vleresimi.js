// Reviews (step 5), the client's side:
//   POST /api/vleresim  { receipt, stars, comment?, author?, email }   stores the review and emails the link that publishes it
//   GET  /vleresimi?t=<token>                                         the emailed link: a page, so link scanners publish nothing
//   POST /vleresimi     t, veprimi = konfirmo | fshi                   publishes the review, or deletes it later
// Reviews can only be written while the directory is open.

import { readAdminConfig } from '../server/admin.js';
import { directoryOpen } from '../server/directory.js';
import { profilePath } from '../server/handle.js';
import { crossSite, fail, json, notAllowed, readJson } from '../server/http.js';
import { esc, homeLink, page } from '../server/pages.js';
import {
  REVIEW_MESSAGES, confirmReview, deleteOwnReview, reviewByToken, reviewsMaintenance, submitReview, validateReview,
} from '../server/reviews.js';
import { MESSAGES, missingCoreConfig } from '../server/signin.js';
import { log } from '../server/subscribers.js';

const RESULT = {
  early: [400, REVIEW_MESSAGES.early],
  late: [400, REVIEW_MESSAGES.late],
  invalid: [400, REVIEW_MESSAGES.invalid],
  used: [409, REVIEW_MESSAGES.used],
  gone: [404, REVIEW_MESSAGES.gone],
  rate_limited: [429, REVIEW_MESSAGES.rateLimited],
};

export const dergo = {
  async onRequestPost({ request, env, waitUntil }) {
    if (crossSite(request)) return fail(403, MESSAGES.generic);
    const input = await readJson(request);
    if (input.error) return input.error;
    const cfg = readAdminConfig(env);
    if (!directoryOpen(env)) return fail(404, REVIEW_MESSAGES.invalid);
    if (missingCoreConfig(cfg).length || !cfg.email.apiKey || !cfg.email.from) {
      log('config_missing', { missing: [...missingCoreConfig(cfg), ...(cfg.email.apiKey ? [] : ['RESEND_API_KEY'])] });
      return fail(503, MESSAGES.generic);
    }
    const data = input.data;
    // A filled honeypot is a bot: it gets the usual answer and nothing happens.
    if (typeof data.company_site === 'string' && data.company_site) return json(200, { ok: true, message: REVIEW_MESSAGES.sent });
    const { review, errors } = validateReview(data);
    const fields = Object.keys(errors);
    if (fields.length) return fail(400, errors[fields[0]], { errors, field: fields[0] });
    try {
      const now = Date.now();
      const out = await submitReview(cfg, data.receipt, review, request.headers.get('CF-Connecting-IP'), now);
      waitUntil(reviewsMaintenance(cfg, now).catch((e) => log('maintenance_failed', { reason: e.message })));
      if (out.result === 'sent') return json(200, { ok: true, message: REVIEW_MESSAGES.sent });
      const [status, message] = RESULT[out.result] || [500, MESSAGES.generic];
      return fail(status, message, { reason: out.result });
    } catch (e) {
      log('review_error', { reason: e.message });
      return fail(500, MESSAGES.generic);
    }
  },
  onRequest: notAllowed('POST'),
};

// ---------- the emailed link ----------

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const profileLink = (path) => (path
  ? `<p class="notice-action"><a class="btn" href="${esc(path)}">Shiko profilin e mjeshtrit</a></p>`
  : homeLink);

const invalid = () => page({
  title: 'Lidhja nuk vlen', tone: 'error',
  heading: 'Kjo lidhje nuk vlen.',
  body: 'Mund të jetë kopjuar gabim, ose vlerësimi është fshirë.',
  action: homeLink,
}, 400);

const unavailable = (t, veprimi) => page({
  title: 'Provo përsëri', tone: 'error', heading: 'Diçka nuk shkoi si duhet. Provo përsëri pas pak.',
  action: `<form class="notice-action" method="post" action="/vleresimi"><input type="hidden" name="t" value="${esc(t)}"><input type="hidden" name="veprimi" value="${esc(veprimi)}"><button class="btn" type="submit">Provo përsëri</button></form>`,
}, 503);

function published(t, path, heading = 'Vlerësimi yt është publikuar.') {
  return page({
    title: 'Vlerësimi',
    heading,
    body: 'Faleminderit që i ndihmon të tjerët ta gjejnë mjeshtrin e duhur. Nëse ndërron mendje, me këtë lidhje mund ta fshish vlerësimin.',
    action: `${profileLink(path)}
    <form class="notice-action" method="post" action="/vleresimi"><input type="hidden" name="t" value="${esc(t)}"><input type="hidden" name="veprimi" value="fshi"><button class="btn btn-ghost-notice" type="submit">Fshije vlerësimin</button></form>`,
  });
}

function setup(env) {
  const cfg = readAdminConfig(env);
  if (missingCoreConfig(cfg).length) { log('config_missing', { missing: missingCoreConfig(cfg) }); return null; }
  return cfg;
}

export const lidhja = {
  async onRequestGet({ request, env }) {
    const t = new URL(request.url).searchParams.get('t') || '';
    if (!TOKEN.test(t)) return invalid();
    const cfg = setup(env);
    if (!cfg) return unavailable(t, 'konfirmo');
    try {
      const row = await reviewByToken(cfg, t);
      if (!row) return invalid();
      if (row.status !== 'unconfirmed') {
        return published(t, row.pro_status === 'approved' && row.handle ? profilePath(row.name, row.handle) : null);
      }
      return page({
        title: 'Publiko vlerësimin',
        heading: 'Po e publikojmë vlerësimin…',
        body: 'Nëse kjo faqe nuk ndryshon, shtyp butonin.',
        action: `<form class="notice-action" method="post" action="/vleresimi" data-autosubmit>
      <input type="hidden" name="t" value="${esc(t)}"><input type="hidden" name="veprimi" value="konfirmo">
      <button class="btn" type="submit">Publiko vlerësimin</button>
    </form>`,
        script: '/notice.js',
      });
    } catch (e) {
      log('review_error', { reason: e.message });
      return unavailable(t, 'konfirmo');
    }
  },

  // No Origin check: the page uses no-referrer (so the token never leaks), which makes browsers send "Origin: null".
  // The token from the email is what authorises both actions.
  async onRequestPost({ request, env }) {
    const form = await request.formData().catch(() => null);
    const t = form && form.get('t');
    const veprimi = form && form.get('veprimi');
    if (typeof t !== 'string' || !TOKEN.test(t) || (veprimi !== 'konfirmo' && veprimi !== 'fshi')) return invalid();
    const cfg = setup(env);
    if (!cfg) return unavailable(t, veprimi);
    try {
      const now = Date.now();
      if (veprimi === 'fshi') {
        const out = await deleteOwnReview(cfg, t);
        if (out.result !== 'deleted') return invalid();
        return page({ title: 'Vlerësimi u fshi', heading: 'Vlerësimi yt u fshi.', body: 'Nuk shfaqet më në profilin e mjeshtrit.', action: profileLink(out.path) });
      }
      const out = await confirmReview(cfg, t, now);
      if (out.result === 'confirmed') return published(t, out.path, 'Vlerësimi u publikua. Faleminderit!');
      if (out.result === 'already') return published(t, out.path);
      if (out.result === 'expired') {
        return page({
          title: 'Lidhja ka skaduar', tone: 'error',
          heading: 'Kjo lidhje ka skaduar.',
          body: 'Lidhja vlen 48 orë. Shkruaje vlerësimin sërish te Thirrjet e mia dhe të dërgojmë një lidhje të re.',
          action: '<p class="notice-action"><a class="btn" href="/thirrjet">Thirrjet e mia</a></p>',
        }, 410);
      }
      if (out.result === 'used') {
        return page({ title: 'Vlerësimi', tone: 'error', heading: REVIEW_MESSAGES.used, body: 'Prandaj ky vlerësim nuk mund të publikohet.', action: homeLink }, 409);
      }
      if (out.result === 'gone') {
        return page({ title: 'Vlerësimi', tone: 'error', heading: REVIEW_MESSAGES.gone, body: 'Prandaj vlerësimi nuk mund të publikohet.', action: homeLink }, 404);
      }
      return invalid();
    } catch (e) {
      log('review_error', { reason: e.message });
      return unavailable(t, veprimi);
    }
  },
};
