// End-to-end test of the mjeshtër sign-in (step 1), the dashboard (step 2), the team admin (step 3), the public directory (step 4)
// reviews (step 5) and ads (step 6) against the real
// Worker, a local D1 database and a local R2 bucket, with scripts/mock-email.mjs standing in for Twilio (SMS), Resend
// (email) and Cloudflare Turnstile. Nothing is sent or stored anywhere else.
//   npm run test:app      (npm test runs it after the signup tests)

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hmac } from '../server/crypto.js';
import { startMockEmail } from './mock-email.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8792;
const MOCK_PORT = 8793;
const OPEN_PORT = 8794;
const BASE = `http://localhost:${PORT}`;
const OPEN = `http://localhost:${OPEN_PORT}`;     // a second server on the same state, with the directory open
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const SECRET = 'test-secret-0123456789abcdefghijklmnopqrstuvwxyz';
const STATE = join(root, '.wrangler', 'test-app');
const wrangler = join(root, 'node_modules', '.bin', 'wrangler');
const TEAM = ['ekipi1@rregullo.test', 'ekipi2@rregullo.test', 'ekipi3@rregullo.test', 'ekipi4@rregullo.test'];

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function sql(command) {
  const out = execFileSync(wrangler, ['d1', 'execute', 'rregullo-launch', '--local', '--persist-to', STATE, '--json', '--command', command],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out)[0].results;
}

/** Every migration, in order, on a fresh database (getPlatformProxy's, for the checks that call handlers directly). */
async function applyMigrations(db) {
  for (const f of readdirSync(join(root, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    const schema = readFileSync(join(root, 'migrations', f), 'utf8');
    for (const stmt of schema.replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(stmt).run();
  }
}

let ipCounter = 1;
const freshIp = () => `203.0.113.${ipCounter++}`;

// wrangler's dev server sometimes drops a kept-alive socket after a response that scheduled background work;
// browsers retry that transparently, so the test does too (only on a socket error). Several idle sockets in the
// pool can be dead at once, so it tries up to three more times.
async function request(url, init) {
  for (let attempt = 0; ; attempt++) {
    try { return await fetch(url, init); } catch (e) {
      if (!(e.cause && e.cause.code === 'UND_ERR_SOCKET') || attempt === 3) throw e;
    }
  }
}

async function api(path, body, { ip = freshIp(), origin = BASE, cookie = '', type = 'application/json' } = {}) {
  const res = await request(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': type, Origin: origin }),
      'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, setCookie: res.headers.get('Set-Cookie') || '' };
}

const askCode = (phone, opts = {}) => api('/api/mjeshtri/kodi', { phone, turnstile: opts.turnstile ?? 'pass' }, opts);
const signIn = (phone, code, opts = {}) => api('/api/mjeshtri/hyr', { phone, code }, opts);
const cookieOf = (setCookie) => setCookie.split(';')[0];
const normalised = (phone) => `+383${phone.replace(/\D/g, '').replace(/^0/, '')}`;

async function main() {
  console.log('Building and starting the local stack…');
  // The directory's homepage switch comes from wrangler.toml here, never from the shell (checked at the end).
  const buildEnv = { ...process.env, SITE_URL: BASE, TURNSTILE_SITE_KEY: '1x00000000000000000000AA' };
  delete buildEnv.DIRECTORY_OPEN;
  execFileSync('node', ['scripts/build.mjs'], { cwd: root, stdio: 'ignore', env: buildEnv });
  rmSync(STATE, { recursive: true, force: true });
  execFileSync(wrangler, ['d1', 'migrations', 'apply', 'rregullo-launch', '--local', '--persist-to', STATE], { cwd: root, stdio: 'ignore' });

  const mock = await startMockEmail(MOCK_PORT);
  const sms = mock.sms;
  // The same settings for both servers; wrangler.toml keeps the directory closed (DIRECTORY_OPEN = "0").
  const vars = (site, more = []) => ['--var', `APP_SECRET:${SECRET}`, '--var', `SITE_URL:${site}`,
    '--var', 'TWILIO_ACCOUNT_SID:ACtest', '--var', 'TWILIO_AUTH_TOKEN:test-token', '--var', `SMS_API_BASE:${MOCK}`,
    '--var', 'TURNSTILE_SECRET_KEY:test-turnstile', '--var', `TURNSTILE_VERIFY_URL:${MOCK}/turnstile/v0/siteverify`,
    '--var', `ADMIN_EMAILS:${TEAM.join(',')}`, '--var', 'RESEND_API_KEY:re_test', '--var', `EMAIL_API_BASE:${MOCK}`, ...more];
  // wrangler dev runs the [build] command on start, so it gets the same build settings.
  const devEnv = { ...buildEnv, NO_PROXY: '127.0.0.1,localhost' };
  async function ready(base) {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${base}/`)).ok) return; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  // The second server (directory open) reads a copy of wrangler.toml without the [build] step, so it never rebuilds
  // dist/ under the first one.
  const swap = (s, re, to) => { assert(re.test(s), `wrangler.toml has no ${re}`); return s.replace(re, to); };
  let openToml = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  openToml = swap(openToml, /^\[build\]\ncommand = .*\n/m, '');
  openToml = swap(openToml, /^main = ".*"$/m, `main = ${JSON.stringify(join(root, 'worker', 'index.js'))}`);
  openToml = swap(openToml, /^directory = "dist"$/m, `directory = ${JSON.stringify(join(root, 'dist'))}`);
  const openConfig = join(STATE, 'wrangler-open.toml');
  writeFileSync(openConfig, openToml);
  const dev = spawn(wrangler, ['dev', '--port', String(PORT), '--persist-to', STATE, ...vars(BASE)],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: devEnv });
  let devLog = '';
  dev.stdout.on('data', (d) => { devLog += d; });
  dev.stderr.on('data', (d) => { devLog += d; });
  await ready(BASE);
  // Started once the first one's build is done, as that rebuild would break this one's static files too.
  const openDev = spawn(wrangler, ['dev', '--config', openConfig, '--port', String(OPEN_PORT), '--inspector-port', '9332', '--persist-to', STATE,
    ...vars(OPEN, ['--var', 'DIRECTORY_OPEN:1'])], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: devEnv });
  let openLog = '';
  openDev.stdout.on('data', (d) => { openLog += d; });
  openDev.stderr.on('data', (d) => { openLog += d; });
  await ready(OPEN);
  // What wrangler prints while starting (the variables above among it) is not the Worker's logging.
  const logStart = devLog.length;
  const openLogStart = openLog.length;
  const lastCode = (to) => {
    const m = [...sms].reverse().find((x) => x.To === to);
    return m && (m.Body.match(/^(\d{6}) /) || [])[1];
  };

  try {
    console.log('The page');
    await check('1. /mjeshtri/ serves the sign-in page with the bot check and its own security policy', async () => {
      const res = await fetch(`${BASE}/mjeshtri/`);
      const html = await res.text();
      assert(res.status === 200 && html.includes('Hyr me numrin e telefonit'), `status ${res.status}`);
      assert(html.includes('data-sitekey="1x00000000000000000000AA"'), 'Turnstile widget');
      const js = await (await fetch(`${BASE}/mjeshtri/mjeshtri.js`)).text();
      assert(js.includes('https://challenges.cloudflare.com/turnstile/v0/api.js'), 'Turnstile is loaded by the page script');
      const csp = res.headers.get('Content-Security-Policy') || '';
      assert(csp.includes('https://challenges.cloudflare.com') && !csp.includes(','), `CSP: ${csp}`);
      assert(/img-src 'self' data: blob:;/.test(csp), `photo previews need blob: in img-src: ${csp}`);
    });

    console.log('Asking for a code');
    await check('2. phone numbers: Kosovo mobiles in any common form accepted, anything else refused', async () => {
      for (const phone of ['', '12345', '+386 41 123 456', '044 12 34', '+383 38 123 456', '044 123 4567', '42 123 456', '+383 (0)38 123 456', 'abc']) {
        const r = await askCode(phone);
        assert(r.status === 400 && r.data.field === 'phone', `${JSON.stringify(phone)} → ${r.status}`);
      }
      for (const [phone, shown] of [['044 123 456', '+383 44 123 456'], ['+383 49-555-111', '+383 49 555 111'], ['0038345222333', '+383 45 222 333'], ['(043) 777 888', '+383 43 777 888'], ['46 333 444', '+383 46 333 444'], ['+383 (0)48 123 999', '+383 48 123 999']]) {
        const r = await askCode(phone);
        assert(r.status === 200 && r.data.phone === shown, `${phone} → ${r.status} ${JSON.stringify(r.data)}`);
      }
    });
    await check('3. failed or missing bot check: refused, no SMS sent', async () => {
      const before = sms.length;
      for (const turnstile of ['fail', '']) {
        const r = await askCode('044 900 001', { turnstile });
        assert(r.status === 400 && r.data.field === 'turnstile', `turnstile=${turnstile} → ${r.status}`);
      }
      assert(sms.length === before, 'an SMS went out');
    });
    await check('4. valid request: one SMS with a 6-digit code; only a hash is stored; no code in the response', async () => {
      const r = await askCode('044 100 200');
      assert(r.status === 200 && r.data.ok && !r.data.devCode, JSON.stringify(r.data));
      const code = lastCode('+38344100200');
      assert(code, 'no SMS to +38344100200');
      const [row] = sql("SELECT code_hash, expires_at, sent_count FROM sms_codes WHERE phone = '+38344100200'");
      assert(row.code_hash && !row.code_hash.includes(code) && row.sent_count === 1, JSON.stringify(row));
      assert(row.expires_at - Date.now() > 9 * 60 * 1000 && row.expires_at - Date.now() <= 10 * 60 * 1000, 'valid for 10 minutes');
    });
    await check('5. a second code within a minute: refused, no SMS', async () => {
      const before = sms.length;
      const r = await askCode('044 100 200');
      assert(r.status === 429 && r.data.message.includes('minutë'), `status ${r.status}`);
      assert(sms.length === before, 'an SMS went out');
    });

    console.log('Signing in');
    let cookie = '';
    await check('6. wrong code: refused, the right one still works afterwards', async () => {
      const code = lastCode('+38344100200');
      const wrong = code === '000000' ? '111111' : '000000';
      const r = await signIn('044 100 200', wrong);
      assert(r.status === 400 && r.data.field === 'code' && !r.data.expired, JSON.stringify(r.data));
      assert(!r.setCookie, 'cookie set on a wrong code');
    });
    await check('7. right code: signed in with an HttpOnly, SameSite cookie for 90 days; account created as a draft', async () => {
      const r = await signIn('+383 44 100 200', lastCode('+38344100200'));
      assert(r.status === 200 && r.data.ok, JSON.stringify(r.data));
      assert(/^rr_mjeshtri=[A-Za-z0-9_-]{43};/.test(r.setCookie) && /HttpOnly/.test(r.setCookie) && /SameSite=Lax/.test(r.setCookie) && /Max-Age=7776000/.test(r.setCookie), r.setCookie);
      cookie = cookieOf(r.setCookie);
      const [pro] = sql("SELECT status, last_login_at FROM pros WHERE phone = '+38344100200'");
      assert(pro && pro.status === 'draft' && pro.last_login_at > 0, JSON.stringify(pro));
      const [s] = sql("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'pro'");
      assert(s.n === 1, 'one session');
      assert(!JSON.stringify(sql('SELECT token_hash FROM sessions')).includes(cookie.split('=')[1]), 'raw token stored');
    });
    await check('8. the code is single-use', async () => {
      const r = await signIn('044 100 200', lastCode('+38344100200'));
      assert(r.status === 400 && r.data.expired, JSON.stringify(r.data));
    });
    await check('9. who am I: the signed-in number with the cookie, 401 without or with a made-up one', async () => {
      const me = await api('/api/mjeshtri/une', undefined, { cookie });
      assert(me.status === 200 && me.data.dashboard.phone === '+383 44 100 200' && me.data.dashboard.status === 'draft', JSON.stringify(me.data));
      assert((await api('/api/mjeshtri/une')).status === 401, 'no cookie');
      assert((await api('/api/mjeshtri/une', undefined, { cookie: `rr_mjeshtri=${'A'.repeat(43)}` })).status === 401, 'made-up cookie');
    });
    await check('10. signing in again with the same number: same account, a second session', async () => {
      sql("UPDATE sms_codes SET last_sent_at = last_sent_at - 61000 WHERE phone = '+38344100200'");
      assert((await askCode('044 100 200')).status === 200, 'code');
      const r = await signIn('044 100 200', lastCode('+38344100200'));
      assert(r.status === 200, `status ${r.status}`);
      assert(sql("SELECT COUNT(*) AS n FROM pros WHERE phone = '+38344100200'")[0].n === 1, 'one account');
      assert(sql("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'pro'")[0].n === 2, 'two sessions');
    });
    await check('11. five wrong guesses: the code is thrown away, even the right one stops working', async () => {
      assert((await askCode('044 300 400')).status === 200, 'code');
      const code = lastCode('+38344300400');
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 4; i++) assert(!(await signIn('044 300 400', wrong)).data.expired, `guess ${i + 1}`);
      assert((await signIn('044 300 400', wrong)).data.expired, 'fifth guess ends it');
      const r = await signIn('044 300 400', code);
      assert(r.status === 400 && r.data.expired, JSON.stringify(r.data));
    });
    await check('12. expired code (older than 10 minutes): refused', async () => {
      sql("UPDATE sms_codes SET last_sent_at = last_sent_at - 61000 WHERE phone = '+38344300400'");
      assert((await askCode('044 300 400')).status === 200, 'code');
      sql("UPDATE sms_codes SET expires_at = 1 WHERE phone = '+38344300400'");
      const r = await signIn('044 300 400', lastCode('+38344300400'));
      assert(r.status === 400 && r.data.expired, JSON.stringify(r.data));
    });

    console.log('SMS cost limits');
    await check('13. at most 5 codes per number per day', async () => {
      sql("UPDATE sms_codes SET sent_count = 5, last_sent_at = last_sent_at - 61000 WHERE phone = '+38344300400'");
      const before = sms.length;
      const r = await askCode('044 300 400');
      assert(r.status === 429 && r.data.message.includes('nesër'), `status ${r.status}`);
      assert(sms.length === before, 'an SMS went out');
      sql("UPDATE sms_codes SET window_start = window_start - 86400001 WHERE phone = '+38344300400'");
      assert((await askCode('044 300 400')).status === 200, 'allowed again the next day');
    });
    await check('14. at most 10 codes per network per hour', async () => {
      const ip = freshIp();
      const codes = [];
      for (let i = 0; i < 11; i++) codes.push((await askCode(`049 500 ${String(100 + i)}`, { ip })).status);
      assert(codes.slice(0, 10).every((c) => c === 200) && codes[10] === 429, codes.join(','));
    });
    await check('15. SMS provider down: generic error, nothing counted, retry allowed at once', async () => {
      mock.setFail(true);
      const r = await askCode('044 600 700');
      mock.setFail(false);
      assert(r.status === 502 && !r.data.ok, `status ${r.status}`);
      const [row] = sql("SELECT code_hash, sent_count FROM sms_codes WHERE phone = '+38344600700'");
      assert(row.code_hash === null && row.sent_count === 0, JSON.stringify(row));
      assert((await askCode('044 600 700')).status === 200, 'retry');
    });

    console.log('Requests from elsewhere');
    await check('16. other sites, form posts and wrong methods: refused', async () => {
      assert((await askCode('044 100 200', { origin: 'https://evil.example' })).status === 403, 'cross-site');
      assert((await api('/api/mjeshtri/hyr', { phone: '044 100 200', code: '123456' }, { origin: `http://localhost.evil.example:${PORT}` })).status === 403, 'lookalike');
      assert((await api('/api/mjeshtri/kodi', 'phone=044100200', { type: 'application/x-www-form-urlencoded' })).status === 415, 'form post');
      assert((await api('/api/mjeshtri/kodi', '{"phone":"0441', {})).status === 400, 'bad JSON');
      assert((await api('/api/mjeshtri/kodi', { phone: '044 100 200', pad: 'x'.repeat(9000) })).status === 413, 'oversized');
      assert((await fetch(`${BASE}/api/mjeshtri/kodi`)).status === 405, 'GET');
      assert((await fetch(`${BASE}/api/mjeshtri/une`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: '{}' })).status === 405, 'POST to une');
    });

    console.log('Signing out');
    await check('17. sign out: cookie cleared, session deleted, the old cookie no longer works', async () => {
      const r = await api('/api/mjeshtri/dil', {}, { cookie });
      assert(r.status === 200 && /^rr_mjeshtri=;/.test(r.setCookie) && /Max-Age=0/.test(r.setCookie), r.setCookie);
      assert((await api('/api/mjeshtri/une', undefined, { cookie })).status === 401, 'still signed in');
      assert(sql("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'pro'")[0].n === 1, 'only the other session is left');
    });
    await check('18. expired session: no longer signed in, removed by the cleanup', async () => {
      sql("UPDATE sms_codes SET last_sent_at = last_sent_at - 61000 WHERE phone = '+38344100200'");
      await askCode('044 100 200');
      const r = await signIn('044 100 200', lastCode('+38344100200'));
      const c = cookieOf(r.setCookie);
      sql("UPDATE sessions SET expires_at = 1 WHERE kind = 'pro'");
      assert((await api('/api/mjeshtri/une', undefined, { cookie: c })).status === 401, 'expired session accepted');
      await askCode('045 111 222');   // any code request runs the cleanup
      await new Promise((res) => setTimeout(res, 1500));
      assert(sql('SELECT COUNT(*) AS n FROM sessions WHERE expires_at = 1')[0].n === 0, 'not cleaned up');
    });


    // ---------- step 2: the dashboard ----------
    const JPEG = readFileSync(join(root, 'scripts', 'fixtures', 'foto.jpg'));     // 480 x 360
    const sized = (w, h) => {      // the fixture with a different size written into its frame header
      const b = Buffer.from(JPEG);
      for (let i = 2; i < b.length - 9; i++) {
        if (b[i] === 0xff && b[i + 1] >= 0xc0 && b[i + 1] <= 0xc3) { b.writeUInt16BE(h, i + 5); b.writeUInt16BE(w, i + 7); return b; }
      }
      throw new Error('no frame header in the fixture');
    };
    const upload = (kind, bytes, { cookie: c = '', type = 'image/jpeg', origin = BASE } = {}) => request(`${BASE}/api/mjeshtri/foto?lloji=${kind}`, {
      method: 'POST', headers: { 'Content-Type': type, Origin: origin, ...(c ? { Cookie: c } : {}) }, body: bytes,
    }).then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }));
    const me = (c) => api('/api/mjeshtri/une', undefined, { cookie: c });
    async function newPro(phone) {
      const e164 = normalised(phone);
      sql(`UPDATE sms_codes SET last_sent_at = last_sent_at - 61000 WHERE phone = '${e164}'`);
      assert((await askCode(phone)).status === 200, `code for ${phone}`);
      const r = await signIn(phone, lastCode(e164));
      assert(r.status === 200, `sign-in for ${phone}`);
      return cookieOf(r.setCookie);
    }
    const proId = (e164) => sql(`SELECT id FROM pros WHERE phone = '${e164}'`)[0].id;
    const FULL = { name: 'Arben Krasniqi', about: 'Punoj si hidraulik prej 15 vitesh në Prishtinë dhe rrethinë. Riparime dhe instalime.', trades: ['hidraulik', 'ngrohje-klime'], towns: ['prishtine', 'fushe-kosove'], years: 15, priceNote: 'nga 20 € / orë', whatsapp: true, viber: false };

    console.log('The dashboard: profile');
    let pro = '';
    await check('21. a new mjeshtër sees an empty draft: required items open, counts at zero, photos enabled', async () => {
      pro = await newPro('044 200 300');
      const r = await me(pro);
      const d = r.data.dashboard;
      assert(r.status === 200 && d.status === 'draft' && d.phone === '+383 44 200 300' && d.photosEnabled === true, JSON.stringify(d));
      assert(d.profile.name === '' && d.profile.trades.length === 0 && d.available === true, 'empty profile');
      assert(!d.checklist.ready && d.checklist.items.filter((i) => i.required && !i.done).map((i) => i.key).join() === 'name,trades,towns,photo', JSON.stringify(d.checklist));
      assert(d.stats.views === 0 && d.stats.calls === 0 && d.stats.whatsapp === 0 && d.stats.viber === 0 && d.stats.rating === null && d.stats.reviews === 0, JSON.stringify(d.stats));
    });
    await check('22. every dashboard action needs a session, comes from this site, and uses the right method', async () => {
      const posts = [['/api/mjeshtri/profili', FULL], ['/api/mjeshtri/disponueshem', { available: false }], ['/api/mjeshtri/dergo', {}],
        ['/api/mjeshtri/foto/fshi', { id: '00000000-0000-4000-8000-000000000000' }], ['/api/mjeshtri/foto/renditja', { ids: [] }], ['/api/mjeshtri/fshi', { confirm: 'FSHIJE' }]];
      for (const [path, body] of posts) {
        const r = await api(path, body);
        assert(r.status === 401 && r.data.signedOut, `${path} without a session → ${r.status}`);
        assert((await api(path, body, { cookie: pro, origin: 'https://evil.example' })).status === 403, `${path} cross-site`);
        assert((await api(path, JSON.stringify(body), { cookie: pro, type: 'text/plain' })).status === 415, `${path} as text/plain`);
        // A type that only mentions JSON isn't JSON (text/plain needs no preflight, so any site could send it).
        assert((await api(path, JSON.stringify(body), { cookie: pro, type: 'text/plain; application/json' })).status === 415, `${path} as text/plain; application/json`);
        assert((await request(`${BASE}${path}`, { headers: { Cookie: pro } })).status === 405, `${path} GET`);
      }
      // A page on http://<this host> is another origin. wrangler dev rewrites Origin to its own address, so this is
      // checked by calling the handler directly, as the live Worker would see it.
      const { profili } = await import('../functions/api/mjeshtri.js');
      const viaHttp = await profili.onRequestPost({
        request: new Request('https://rregullo.net/api/mjeshtri/profili', { method: 'POST', headers: { Origin: 'http://rregullo.net', 'Content-Type': 'application/json' }, body: '{}' }),
        env: {}, waitUntil() {},
      });
      assert(viaHttp.status === 403, `http origin → ${viaHttp.status}`);
      assert((await upload('pune', JPEG)).status === 401, 'upload without a session');
      assert((await upload('pune', JPEG, { cookie: pro, origin: 'https://evil.example' })).status === 403, 'upload cross-site');
      assert((await upload('pune', JPEG, { cookie: pro, type: 'multipart/form-data; boundary=x' })).status === 415, 'upload as a form');
      assert(sql("SELECT COUNT(*) AS n FROM pro_photos")[0].n === 0, 'a photo was stored');
      const [row] = sql("SELECT name, available FROM pros WHERE phone = '+38344200300'");
      assert(row.name === '' && row.available === 1, 'something changed');
    });
    await check('23. saving the profile: text cleaned, lists de-duplicated, numbers parsed; the answer is what was saved', async () => {
      // A draft can be saved step by step, half filled.
      const half = await api('/api/mjeshtri/profili', { name: 'Arben' }, { cookie: pro });
      assert(half.status === 200 && half.data.dashboard.profile.name === 'Arben', `half-filled draft → ${half.status}`);
      assert(half.data.dashboard.checklist.items.filter((i) => i.required && !i.done).map((i) => i.key).join() === 'trades,towns,photo', 'checklist');
      const r = await api('/api/mjeshtri/profili', { ...FULL, name: '  Arben ​ Krasniqi‮ ', trades: ['hidraulik', 'hidraulik', 'ngrohje-klime'], years: '15', about: `${FULL.about}\n\n\n\nThirrni çdo ditë.` }, { cookie: pro });
      assert(r.status === 200 && r.data.ok && r.data.message === 'U ruajt.', JSON.stringify(r.data));
      const p = r.data.dashboard.profile;
      assert(p.name === 'Arben Krasniqi' && p.trades.join() === 'hidraulik,ngrohje-klime' && p.years === 15 && p.whatsapp && !p.viber, JSON.stringify(p));
      assert(p.about.endsWith('rrethinë. Riparime dhe instalime.\n\nThirrni çdo ditë.'), JSON.stringify(p.about));
      const [row] = sql("SELECT name, trades, towns, years, price_note FROM pros WHERE phone = '+38344200300'");
      assert(row.trades === '["hidraulik","ngrohje-klime"]' && row.towns === '["prishtine","fushe-kosove"]' && row.price_note === 'nga 20 € / orë', JSON.stringify(row));
      // Emoji held together by a zero-width joiner survive; a soft hyphen is removed without splitting the word.
      const emoji = await api('/api/mjeshtri/profili', { ...FULL, priceNote: 'Hidraulik 👨‍🔧', about: `${FULL.about} Insta\u00adlime.` }, { cookie: pro });
      const e = emoji.data.dashboard.profile;
      assert(e.priceNote === 'Hidraulik 👨‍🔧' && e.about.endsWith(' Instalime.'), JSON.stringify([e.priceNote, e.about]));
    });
    await check('24. invalid fields: each one named, nothing saved', async () => {
      const bad = { name: 'Arben <script>', about: 'x'.repeat(601), trades: ['hidraulik', 'elektricist', 'bojaxhi', 'pllakaxhi', 'murator', 'kulmi'], towns: ['prishtine', 'atlantis'], years: 61, priceNote: 'x'.repeat(61) };
      const r = await api('/api/mjeshtri/profili', bad, { cookie: pro });
      assert(r.status === 400 && Object.keys(r.data.errors).sort().join() === 'about,name,priceNote,towns,trades,years', JSON.stringify(r.data));
      assert((await api('/api/mjeshtri/profili', { ...FULL, years: 'pesë' }, { cookie: pro })).data.errors.years, 'years as words');
      assert((await api('/api/mjeshtri/profili', { ...FULL, trades: 'hidraulik' }, { cookie: pro })).data.errors.trades, 'trades not a list');
      assert((await api('/api/mjeshtri/profili', { ...FULL, towns: Array(11).fill(0).map((_, i) => ['prishtine', 'prizren', 'ferizaj', 'peje', 'gjakove', 'gjilan', 'podujeve', 'mitrovice', 'vushtrri', 'suhareke', 'rahovec'][i]) }, { cookie: pro })).data.errors.towns, '11 towns');
      assert(sql("SELECT name FROM pros WHERE phone = '+38344200300'")[0].name === 'Arben Krasniqi', 'saved anyway');
    });
    await check('25. sending for approval without a profile photo: refused, the missing item named', async () => {
      const r = await api('/api/mjeshtri/dergo', {}, { cookie: pro });
      assert(r.status === 400 && r.data.missing.join() === 'photo', JSON.stringify(r.data));
      assert(sql("SELECT status FROM pros WHERE phone = '+38344200300'")[0].status === 'draft', 'status changed');
    });

    console.log('The dashboard: photos');
    let profilePhoto = null;
    await check('26. profile photo: stored in R2, served as a sandboxed JPEG cached for a year, 304 when unchanged', async () => {
      const r = await upload('profili', JPEG, { cookie: pro });
      assert(r.status === 200 && r.data.photo && r.data.dashboard.photos.profile.id === r.data.photo.id, JSON.stringify(r.data));
      profilePhoto = r.data.photo;
      assert(profilePhoto.url === `/foto/${profilePhoto.id}.jpg` && profilePhoto.width === 480 && profilePhoto.height === 360, JSON.stringify(profilePhoto));
      const res = await request(`${BASE}${profilePhoto.url}`);
      const body = Buffer.from(await res.arrayBuffer());
      assert(res.status === 200 && body.equals(JPEG), `status ${res.status}, ${body.length} bytes`);
      const h = (k) => res.headers.get(k) || '';
      assert(h('Content-Type') === 'image/jpeg' && h('X-Content-Type-Options') === 'nosniff' && /immutable/.test(h('Cache-Control')) && /sandbox/.test(h('Content-Security-Policy')) && h('ETag'), JSON.stringify(Object.fromEntries(res.headers)));
      assert(h('Last-Modified') && h('Content-Length') === String(JPEG.length), 'Last-Modified / Content-Length');
      const status = async (headers, method = 'GET') => (await request(`${BASE}${profilePhoto.url}`, { method, headers })).status;
      assert(await status({ 'If-None-Match': h('ETag') }) === 304, 'no 304');
      assert(await status({ 'If-None-Match': `W/${h('ETag')}, "other"` }) === 304, 'no 304 for a weak ETag in a list');
      assert(await status({ 'If-None-Match': '"other"' }) === 200, 'a stale ETag got 304');
      // Malformed or other conditional headers are ignored rather than crashing or faking a 304.
      assert(await status({ 'If-None-Match': h('ETag').replace(/"/g, '') }) === 200, 'unquoted ETag');
      assert(await status({ 'If-Match': '"nope"' }) === 200 && await status({ 'If-Match': 'nope' }) === 200, 'If-Match');
      assert(await status({ 'If-Unmodified-Since': 'Mon, 01 Jan 2001 00:00:00 GMT' }) === 200, 'If-Unmodified-Since');
      const head = await request(`${BASE}${profilePhoto.url}`, { method: 'HEAD' });
      assert(head.status === 200 && head.headers.get('Content-Length') === String(JPEG.length) && (await head.arrayBuffer()).byteLength === 0, `HEAD ${head.status}`);
      assert(await status({ 'If-None-Match': h('ETag') }, 'HEAD') === 304, 'HEAD: no 304');
      assert((await request(`${BASE}${profilePhoto.url}`, { method: 'POST' })).status === 405, 'POST to a photo');
      for (const path of ['/foto/nope.jpg', '/foto/00000000-0000-4000-8000-000000000000.jpg', `/foto/${profilePhoto.id.toUpperCase()}.jpg`, `/foto/${profilePhoto.id}.jpg.png`]) {
        assert((await request(`${BASE}${path}`)).status === 404, `${path} found`);
      }
    });
    await check('27. uploads that are not our JPEGs: refused, nothing stored', async () => {
      const before = sql('SELECT COUNT(*) AS n FROM pro_photos')[0].n;
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
      for (const [what, bytes, kind] of [['a PNG', png, 'pune'], ['text', Buffer.from('hello'), 'pune'], ['an empty body', Buffer.alloc(0), 'pune'],
        ['too small (150 px)', sized(150, 150), 'pune'], ['too large (4000 px)', sized(4000, 3000), 'pune'], ['an unknown kind', JPEG, 'tjeter']]) {
        const r = await upload(kind, bytes, { cookie: pro });
        assert(r.status === 400 && !r.data.ok, `${what} → ${r.status}`);
      }
      // The phone aims at exactly these edges (shorter side 200, longer side 2048), so they must stay accepted.
      for (const [w, h] of [[199, 1000], [1000, 2049]]) assert((await upload('pune', sized(w, h), { cookie: pro })).status === 400, `${w}x${h} accepted`);
      for (const [w, h] of [[2048, 200], [200, 2048]]) {
        const r = await upload('pune', sized(w, h), { cookie: pro });
        assert(r.status === 200, `${w}x${h} refused`);
        await api('/api/mjeshtri/foto/fshi', { id: r.data.photo.id }, { cookie: pro });
      }
      const big = Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]);
      assert((await upload('pune', big, { cookie: pro })).status === 413, 'over 2 MB');
      // Without a Content-Length (sent in chunks) the server stops reading once it passes 2 MB.
      const chunked = await request(`${BASE}/api/mjeshtri/foto?lloji=pune`, {
        method: 'POST', headers: { 'Content-Type': 'image/jpeg', Origin: BASE, Cookie: pro }, duplex: 'half',
        body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(JPEG)); for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(512 * 1024)); c.close(); } }),
      });
      assert(chunked.status === 413, `chunked over 2 MB → ${chunked.status}`);
      // Local only: after a Worker stops reading a body, wrangler dev's proxy fails the next request with a 500.
      const absorbed = await request(`${BASE}/api/mjeshtri/une`, { headers: { Cookie: pro } });
      if (absorbed.status !== 200) assert((await me(pro)).status === 200, 'the server did not recover after the refused upload');
      assert(sql('SELECT COUNT(*) AS n FROM pro_photos')[0].n === before, 'something was stored');
    });
    await check('27a. a photo sent with location data (Exif) is stored without it', async () => {
      const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), Buffer.from('GPS 42.6629 N 21.1655 E camera'.repeat(4))]);
      const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1, (exif.length + 2) >> 8, (exif.length + 2) & 0xFF]), exif]);
      const comment = Buffer.concat([Buffer.from([0xFF, 0xFE, 0x00, 0x0C]), Buffer.from('Arben 2026')]);
      const tagged = Buffer.concat([JPEG.subarray(0, 2), app1, comment, JPEG.subarray(2)]);
      const r = await upload('pune', tagged, { cookie: pro });
      assert(r.status === 200, `status ${r.status}`);
      const stored = Buffer.from(await (await request(`${BASE}${r.data.photo.url}`)).arrayBuffer());
      assert(stored.equals(JPEG), `stored ${stored.length} bytes, expected the ${JPEG.length} without Exif`);
      assert(!stored.includes(Buffer.from('GPS')) && !stored.includes(Buffer.from('Arben')), 'metadata kept');
      const del = await api('/api/mjeshtri/foto/fshi', { id: r.data.photo.id }, { cookie: pro });
      assert(del.status === 200, 'cleanup');
    });
    await check('28. a new profile photo replaces the old one, which is deleted from R2', async () => {
      const r = await upload('profili', JPEG, { cookie: pro });
      assert(r.status === 200 && r.data.photo.id !== profilePhoto.id, `status ${r.status}`);
      assert((await request(`${BASE}${profilePhoto.url}`)).status === 404, 'old photo still served');
      assert(sql(`SELECT COUNT(*) AS n FROM pro_photos WHERE kind = 'profile' AND pro_id = '${proId('+38344200300')}'`)[0].n === 1, 'two profile photos');
      profilePhoto = r.data.photo;
    });
    let work = [];
    await check('29. work photos: twelve at most; the thirteenth is refused and not stored', async () => {
      for (let i = 0; i < 12; i++) {
        const r = await upload('pune', JPEG, { cookie: pro });
        assert(r.status === 200, `photo ${i + 1} → ${r.status} ${JSON.stringify(r.data)}`);
        work = r.data.dashboard.photos.work;
      }
      assert(work.length === 12, `${work.length} work photos`);
      const r = await upload('pune', JPEG, { cookie: pro });
      assert(r.status === 400 && r.data.message.includes('12'), `13th → ${r.status}`);
      assert(sql("SELECT COUNT(*) AS n FROM pro_photos WHERE kind = 'work'")[0].n === 12, 'stored anyway');
    });
    await check('30. ordering work photos: any order of exactly my photos; anything else refused', async () => {
      const ids = work.map((p) => p.id).reverse();
      const r = await api('/api/mjeshtri/foto/renditja', { ids }, { cookie: pro });
      assert(r.status === 200 && r.data.dashboard.photos.work.map((p) => p.id).join() === ids.join(), 'order not saved');
      for (const bad of [ids.slice(1), [...ids.slice(1), profilePhoto.id], [...ids.slice(1), ids[1]], 'x', [...ids, ids[0]]]) {
        assert((await api('/api/mjeshtri/foto/renditja', { ids: bad }, { cookie: pro })).status === 400, `accepted ${JSON.stringify(bad).slice(0, 40)}`);
      }
      work = r.data.dashboard.photos.work;
    });
    let other = '';
    await check("31. deleting a photo: gone from R2 and the list; someone else's photo can't be deleted", async () => {
      other = await newPro('044 200 301');
      const theirs = (await upload('pune', JPEG, { cookie: other })).data.photo;
      const r1 = await api('/api/mjeshtri/foto/fshi', { id: theirs.id }, { cookie: pro });
      assert(r1.status === 404, `deleted someone else's photo: ${r1.status}`);
      assert((await request(`${BASE}${theirs.url}`)).status === 200, 'their photo is gone');
      const victim = work[0];
      const r2 = await api('/api/mjeshtri/foto/fshi', { id: victim.id }, { cookie: pro });
      assert(r2.status === 200 && r2.data.dashboard.photos.work.length === 11, `status ${r2.status}`);
      assert((await request(`${BASE}${victim.url}`)).status === 404, 'still served');
      assert((await api('/api/mjeshtri/foto/fshi', { id: victim.id }, { cookie: pro })).status === 404, 'deleted twice');
      assert((await api('/api/mjeshtri/foto/fshi', { id: "x' OR 1=1 --" }, { cookie: pro })).status === 404, 'odd id');
    });
    await check('32. at most 60 uploads a day per mjeshtër', async () => {
      const bucket = await hmac(SECRET, 'photo-upload', proId('+38344200301'));
      const now = Date.now();
      sql(`INSERT INTO rate_events (bucket, at) VALUES ${Array.from({ length: 60 }, (_, i) => `('${bucket}', ${now - i * 1000})`).join(', ')}`);
      const r = await upload('pune', JPEG, { cookie: other });
      assert(r.status === 429 && r.data.message.includes('nesër'), `status ${r.status}`);
    });

    console.log('The dashboard: approval, availability, account');
    await check('33. sending a complete profile: pending, and saying so again is harmless; edits keep it pending but complete', async () => {
      const r = await api('/api/mjeshtri/dergo', {}, { cookie: pro });
      assert(r.status === 200 && r.data.dashboard.status === 'pending' && r.data.dashboard.submittedAt > 0, JSON.stringify(r.data));
      const again = await api('/api/mjeshtri/dergo', {}, { cookie: pro });
      assert(again.status === 200 && again.data.dashboard.status === 'pending', `again: ${again.status}`);
      const edit = await api('/api/mjeshtri/profili', { ...FULL, years: 16 }, { cookie: pro });
      assert(edit.status === 200 && edit.data.dashboard.status === 'pending', 'edit changed the status');
      // Once sent, the profile can't be emptied of what was needed to send it.
      const emptied = await api('/api/mjeshtri/profili', { ...FULL, name: ' ', trades: [], towns: [] }, { cookie: pro });
      assert(emptied.status === 400 && ['name', 'trades', 'towns'].every((k) => emptied.data.errors[k]), JSON.stringify(emptied.data));
      assert(sql("SELECT years FROM pros WHERE phone = '+38344200300'")[0].years === 16, 'saved anyway');
    });
    await check('34. rejected with a reason: shown, and sending again clears it', async () => {
      sql("UPDATE pros SET status = 'rejected', status_note = 'Fotoja e profilit nuk duket qartë.' WHERE phone = '+38344200300'");
      const d = (await me(pro)).data.dashboard;
      assert(d.status === 'rejected' && d.statusNote === 'Fotoja e profilit nuk duket qartë.', JSON.stringify(d));
      const r = await api('/api/mjeshtri/dergo', {}, { cookie: pro });
      assert(r.status === 200 && r.data.dashboard.status === 'pending' && r.data.dashboard.statusNote === '', JSON.stringify(r.data.dashboard));
    });
    await check('35. "Marr punë tani" switch: saved; anything but true/false refused', async () => {
      const off = await api('/api/mjeshtri/disponueshem', { available: false }, { cookie: pro });
      assert(off.status === 200 && off.data.dashboard.available === false, JSON.stringify(off.data));
      assert(sql("SELECT available FROM pros WHERE phone = '+38344200300'")[0].available === 0, 'not saved');
      assert((await api('/api/mjeshtri/disponueshem', { available: 'po' }, { cookie: pro })).status === 400, 'accepted a string');
      assert((await api('/api/mjeshtri/disponueshem', { available: true }, { cookie: pro })).data.dashboard.available === true, 'back on');
    });
    await check('36. Ballina counts: the last 30 days only', async () => {
      const id = proId('+38344200300');
      const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
      sql(`INSERT INTO pro_stats_daily (pro_id, day, views, calls, whatsapp, viber) VALUES ('${id}', '${day(0)}', 10, 3, 2, 1), ('${id}', '${day(29)}', 5, 1, 0, 0), ('${id}', '${day(31)}', 100, 100, 100, 100)`);
      const s = (await me(pro)).data.dashboard.stats;
      assert(s.days === 30 && s.views === 15 && s.calls === 4 && s.whatsapp === 2 && s.viber === 1, JSON.stringify(s));
    });
    await check('37. suspended: can look, sign out and delete, but not edit, upload or send', async () => {
      sql("UPDATE pros SET status = 'suspended', status_note = 'Ankesa nga klientët.' WHERE phone = '+38344200301'");
      assert((await me(other)).data.dashboard.status === 'suspended', 'status');
      assert((await api('/api/mjeshtri/profili', FULL, { cookie: other })).status === 403, 'edit');
      assert((await api('/api/mjeshtri/dergo', {}, { cookie: other })).status === 403, 'send');
      assert((await api('/api/mjeshtri/disponueshem', { available: true }, { cookie: other })).status === 403, 'switch');
      sql(`DELETE FROM rate_events WHERE bucket = '${await hmac(SECRET, 'photo-upload', proId('+38344200301'))}'`);
      assert((await upload('pune', JPEG, { cookie: other })).status === 403, 'upload');
      assert((await api('/api/mjeshtri/foto/fshi', { id: '00000000-0000-4000-8000-000000000000' }, { cookie: other })).status === 403, 'delete a photo');
      const theirs = (await me(other)).data.dashboard.photos.work.map((p) => p.id);
      assert((await api('/api/mjeshtri/foto/renditja', { ids: theirs.reverse() }, { cookie: other })).status === 403, 'reorder');
    });
    await check('38. sign out everywhere: every session of this mjeshtër ends, nobody else\'s', async () => {
      const second = await newPro('044 200 300');
      const r = await api('/api/mjeshtri/dil', { all: true }, { cookie: second });
      assert(r.status === 200 && /Max-Age=0/.test(r.setCookie), r.setCookie);
      assert((await me(pro)).status === 401 && (await me(second)).status === 401, 'still signed in somewhere');
      assert((await me(other)).status === 200, "someone else's session ended");
      pro = await newPro('044 200 300');
    });
    await check('39. deleting the account: needs the confirmation word; then the profile, photos (R2 too), counts and sessions are gone', async () => {
      const id = proId('+38344200300');
      const urls = sql(`SELECT id FROM pro_photos WHERE pro_id = '${id}'`).map((r) => `/foto/${r.id}.jpg`);
      assert(urls.length === 12, `${urls.length} photos before`);
      assert((await api('/api/mjeshtri/fshi', {}, { cookie: pro })).status === 400, 'deleted without the word');
      const r = await api('/api/mjeshtri/fshi', { confirm: 'FSHIJE' }, { cookie: pro });
      assert(r.status === 200 && /Max-Age=0/.test(r.setCookie), `status ${r.status}`);
      for (const table of ['pros', 'pro_photos', 'pro_stats_daily']) {
        const col = table === 'pros' ? 'id' : 'pro_id';
        assert(sql(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = '${id}'`)[0].n === 0, `${table} still has rows`);
      }
      assert(sql(`SELECT COUNT(*) AS n FROM sessions WHERE subject = '${id}'`)[0].n === 0, 'sessions left');
      for (const u of urls) assert((await request(`${BASE}${u}`)).status === 404, `${u} still served`);
      assert((await me(pro)).status === 401, 'still signed in');
      assert((await me(other)).status === 200, "someone else's account is affected");
      const again = await newPro('044 200 300');
      assert((await me(again)).data.dashboard.profile.name === '', 'signing in again starts a fresh, empty account');
    });
    await check('39a. a suspended account deleted: profile and photos gone, but the number stays suspended', async () => {
      const id = proId('+38344200301');
      const r = await api('/api/mjeshtri/fshi', { confirm: 'FSHIJE' }, { cookie: other });
      assert(r.status === 200 && r.data.message.includes('pezulluar'), JSON.stringify(r.data));
      const [row] = sql(`SELECT name, trades, status, status_note FROM pros WHERE id = '${id}'`);
      assert(row && row.name === '' && row.trades === '[]' && row.status === 'suspended' && row.status_note === 'Ankesa nga klientët.', JSON.stringify(row));
      assert(sql(`SELECT COUNT(*) AS n FROM pro_photos WHERE pro_id = '${id}'`)[0].n === 0, 'photos left');
      const back = await newPro('044 200 301');
      const d = (await me(back)).data.dashboard;
      assert(d.status === 'suspended' && d.statusNote === 'Ankesa nga klientët.', JSON.stringify(d));
      assert((await api('/api/mjeshtri/profili', FULL, { cookie: back })).status === 403, 'can edit again');
    });

    console.log('Production settings');
    await check('40. live site: no code ever sent without the SMS and bot-check secrets; the cookie is Secure', async () => {
      const { getPlatformProxy } = await import('wrangler');
      const { kodi, hyr } = await import('../functions/api/mjeshtri.js');
      const proxy = await getPlatformProxy({ persist: false });
      try {
        const db = proxy.env.DB;
        await applyMigrations(db);
        const live = { DB: db, SITE_URL: 'https://rregullo.net', APP_SECRET: SECRET };
        const call = (mod, env, body) => mod.onRequestPost({ env, waitUntil() {}, request: new Request(`https://rregullo.net/api/mjeshtri/${mod === kodi ? 'kodi' : 'hyr'}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://rregullo.net', 'CF-Connecting-IP': freshIp() }, body: JSON.stringify(body),
        }) });
        assert((await call(kodi, live, { phone: '044 700 800', turnstile: 'pass' })).status === 503, 'sent without secrets');
        const full = { ...live, TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 't', SMS_API_BASE: MOCK, TURNSTILE_SECRET_KEY: 's', TURNSTILE_VERIFY_URL: `${MOCK}/turnstile/v0/siteverify` };
        const r = await call(kodi, full, { phone: '044 700 800', turnstile: 'pass' });
        const data = await r.json();
        assert(r.status === 200 && !data.devCode, `status ${r.status}`);
        const ok = await call(hyr, full, { phone: '044 700 800', code: lastCode('+38344700800') });
        assert(ok.status === 200 && /; Secure;/.test(ok.headers.get('Set-Cookie')), ok.headers.get('Set-Cookie'));
      } finally {
        await proxy.dispose();
      }
    });
    await check('40a. uploads at the same moment: the 12-photo and 60-a-day limits hold, and losing uploads leave no file', async () => {
      // wrangler dev answers one request at a time, so this calls savePhoto directly, where the database calls interleave.
      const { getPlatformProxy } = await import('wrangler');
      const { savePhoto } = await import('../server/photos.js');
      const proxy = await getPlatformProxy({ persist: false });
      try {
        const db = proxy.env.DB;
        await applyMigrations(db);
        const stored = new Set();
        const bucket = {
          put: async (key) => { stored.add(key); },
          delete: async (keys) => { for (const k of [].concat(keys)) stored.delete(k); },
        };
        const cfg = { db, photos: bucket, appSecret: SECRET };
        const now = Date.now();
        await db.prepare("INSERT INTO pros (id, phone, created_at, updated_at) VALUES ('p1', '+38344900001', 0, 0), ('p2', '+38344900002', 0, 0)").run();
        for (let i = 0; i < 11; i++) {
          await db.prepare("INSERT INTO pro_photos (id, pro_id, kind, width, height, bytes, position, created_at) VALUES (?1, 'p1', 'work', 480, 360, 1, ?2, 0)").bind(`old-${i}`, i).run();
        }
        const cap = await Promise.all([1, 2, 3, 4].map(() => savePhoto(cfg, 'p1', 'work', JPEG, now)));
        const results = cap.map((r) => r.result).sort().join();
        assert(results === 'limit,limit,limit,ok', results);
        assert((await db.prepare("SELECT COUNT(*) AS n FROM pro_photos WHERE pro_id = 'p1'").first()).n === 12, 'more than 12 stored');
        assert(stored.size === 1, `${stored.size} files left in the bucket`);

        const key = await hmac(SECRET, 'photo-upload', 'p2');
        for (let i = 0; i < 59; i++) await db.prepare('INSERT INTO rate_events (bucket, at) VALUES (?1, ?2)').bind(key, now - 1000 - i).run();
        const day = await Promise.all([1, 2, 3, 4].map(() => savePhoto(cfg, 'p2', 'work', JPEG, now)));
        const dayResults = day.map((r) => r.result).sort().join();
        assert(dayResults === 'ok,too_many_today,too_many_today,too_many_today', dayResults);
      } finally {
        await proxy.dispose();
      }
    });
    await check('40b. previews (no database, no photo storage): errors, never a crash', async () => {
      const worker = (await import('../worker/index.js')).default;
      const env = { SITE_URL: 'https://rregullo.net', APP_SECRET: SECRET, ASSETS: { fetch: () => new Response('') } };
      const go = (path, init) => worker.fetch(new Request(`https://rregullo.net${path}`, init), env, { waitUntil() {} });
      assert((await go('/api/mjeshtri/une')).status === 503, 'une');
      const up = await go('/api/mjeshtri/foto?lloji=pune', { method: 'POST', headers: { 'Content-Type': 'image/jpeg', Origin: 'https://rregullo.net' }, body: JPEG });
      assert(up.status === 503, `upload → ${up.status}`);
      assert((await go('/foto/00000000-0000-4000-8000-000000000000.jpg')).status === 404, 'photo');
    });
    await check('41. logs contain no phone numbers or codes', async () => {
      // Photo ids are random UUIDs, and their digits can look like a number or a code by chance: leave them out.
      const scanned = devLog.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');
      const hit = scanned.match(/\+?383\s?4\d|04\d\s?\d{3}/);
      assert(!hit, `a phone number appears in the logs: ${hit && JSON.stringify(scanned.slice(Math.max(0, hit.index - 80), hit.index + 40))}`);
      for (const m of sms) {
        const code = (m.Body.match(/^(\d{6}) /) || [])[1];
        assert(!new RegExp(`(?<!\\d)${code}(?!\\d)`).test(scanned), 'a code appears in the logs');
      }
    });

    // ---------- step 3: the team admin ----------
    const LINK_SUBJECT = 'Hyrja në panelin e ekipit të Rregullo';
    const QUEUE_SUBJECT = 'Një profil i ri pret shqyrtim';
    const team = (path, body, opts) => api(`/api/admin/${path}`, body, opts);
    const linksTo = (addr) => mock.messages.filter((m) => m.subject === LINK_SUBJECT && m.to.includes(addr));
    const tokenOf = (m) => (m.text.match(/\/admin\/#hyr=([A-Za-z0-9_-]{43})/) || [])[1];
    const codeOf = (m) => (m.text.match(/\b(\d{6})\b/) || [])[1];
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    // Links are emailed after the answer has gone out, so the mock is polled.
    async function until(cond, what, ms = 8000) {
      for (let t = 0; t < ms; t += 100) { if (cond()) return; await pause(100); }
      throw new Error(`timed out waiting for ${what}`);
    }
    // A new link for a team address. Its earlier links stop counting towards the 3-per-15-minutes cap (they still work).
    async function newLink(addr) {
      sql(`UPDATE admin_links SET created_at = created_at - 900001 WHERE email = '${addr}'`);
      const before = linksTo(addr).length;
      const r = await team('lidhja', { email: addr });
      assert(r.status === 200, `link for ${addr} → ${r.status}`);
      await until(() => linksTo(addr).length > before, `the link email to ${addr}`);
      const m = linksTo(addr).at(-1);
      return { token: tokenOf(m), code: codeOf(m) };
    }
    const sameAnswer = (a, b) => a.status === b.status && JSON.stringify(a.data) === JSON.stringify(b.data);
    const teamUpload = (id, kind, bytes, { cookie: c = '', origin = BASE, type = 'image/jpeg' } = {}) => request(`${BASE}/api/admin/foto?id=${encodeURIComponent(id)}&lloji=${kind}`, {
      method: 'POST', headers: { 'Content-Type': type, Origin: origin, ...(c ? { Cookie: c } : {}) }, body: bytes,
    }).then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }));
    const ascii160 = (body) => {
      const live = body.replace(BASE, 'https://rregullo.net');
      return /^[\x20-\x7e]+$/.test(live) && live.length <= 160 && live.endsWith('https://rregullo.net/mjeshtri');
    };

    console.log('Team admin: the page and signing in');
    await check('42. /admin/ serves the team page: its own security policy without the bot check, never indexed; robots.txt keeps out', async () => {
      const res = await fetch(`${BASE}/admin/`);
      const html = await res.text();
      assert(res.status === 200 && html.includes('<meta name="robots" content="noindex'), `status ${res.status}`);
      assert(!/\{\{\w+\}\}|<!-- @/.test(html), 'template markers left');
      const csp = res.headers.get('Content-Security-Policy') || '';
      assert(/script-src 'self';/.test(csp) && !csp.includes('challenges.cloudflare.com') && csp.includes("frame-ancestors 'none'") && !csp.includes(','), `CSP: ${csp}`);
      assert(/img-src 'self' data: blob:;/.test(csp) && csp.includes("connect-src 'self'"), `CSP: ${csp}`);
      assert(/noindex/.test(res.headers.get('X-Robots-Tag') || ''), 'X-Robots-Tag');
      assert(/no-cache/.test(res.headers.get('Cache-Control') || ''), `Cache-Control: ${res.headers.get('Cache-Control')}`);
      const assets = [...html.matchAll(/(?:src|href)="(\/(?:admin|mjeshtri)\/[^"?]+)\?v=[0-9a-f]+"/g)].map((m) => m[1]);
      assert(assets.includes('/admin/admin.js') && assets.includes('/admin/admin.css'), assets.join());
      for (const a of assets) assert((await fetch(`${BASE}${a}`)).status === 200, `${a} not served`);
      const robots = await (await fetch(`${BASE}/robots.txt`)).text();
      assert(robots.includes('Disallow: /admin/'), robots);
    });
    await check('43. asking for a link: the same answer for a team address, an unknown one and one over its limit; only the team gets an email', async () => {
      const before = mock.messages.length;
      const allowed = await team('lidhja', { email: TEAM[0] });
      const unknown = await team('lidhja', { email: 'askush@rregullo.test' });
      const shouted = await team('lidhja', { email: '  EKIPI2@Rregullo.TEST ' });
      assert(allowed.status === 200 && allowed.data.ok && allowed.data.message.includes('15 minuta'), JSON.stringify(allowed.data));
      assert(sameAnswer(allowed, unknown) && sameAnswer(allowed, shouted), JSON.stringify([unknown.data, shouted.data]));
      await until(() => linksTo(TEAM[0]).length === 1 && linksTo(TEAM[1]).length === 1, 'the two link emails');
      await pause(1000);
      assert(mock.messages.length === before + 2, `${mock.messages.length - before} emails`);
      assert(!mock.messages.some((m) => m.to.includes('askush@rregullo.test')), 'an unknown address got an email');
      const m = linksTo(TEAM[0])[0];
      const token = tokenOf(m);
      const code = codeOf(m);
      assert(token && code, m.text);
      assert(m.text.includes(`Kodi: ${code}`) && m.text.includes(`${BASE}/admin/#hyr=${token}`) && m.html.includes(`${BASE}/admin/#hyr=${token}`) && m.html.includes(code), 'link or code missing');
      assert(m.text.includes('Nëse nuk e ke kërkuar ti, mos bëj asgjë.'), 'footer');
      const rows = sql('SELECT email, token_hash, code_hash, attempts, expires_at - created_at AS ttl, used_at FROM admin_links ORDER BY email');
      assert(rows.map((r) => r.email).join() === TEAM.slice(0, 2).join(), JSON.stringify(rows));
      assert(rows.every((r) => r.ttl === 15 * 60 * 1000 && r.attempts === 0 && r.used_at === null), JSON.stringify(rows));
      assert(!JSON.stringify(rows).includes(token) && !rows.some((r) => r.code_hash.includes(code)), 'stored in the clear');
      // Three links per address per 15 minutes; the fourth gets the same answer and no email.
      for (let i = 0; i < 2; i++) assert((await team('lidhja', { email: TEAM[0] })).status === 200, `link ${i + 2}`);
      await until(() => linksTo(TEAM[0]).length === 3, 'three links');
      const capped = await team('lidhja', { email: TEAM[0] });
      assert(sameAnswer(allowed, capped), JSON.stringify(capped.data));
      await pause(1500);
      assert(linksTo(TEAM[0]).length === 3, 'a fourth link went out');
    });
    await check('44. asking for a link: a malformed address, another site, a form post or a GET is refused', async () => {
      for (const email of ['', 'ekipi1', 'ekipi1@', '@rregullo.test', 'ekipi1@rregullo', 'a b@rregullo.test', `${'a'.repeat(250)}@rregullo.test`, 42, null]) {
        const r = await team('lidhja', { email });
        assert(r.status === 400 && r.data.field === 'email', `${JSON.stringify(email)} → ${r.status}`);
      }
      assert((await team('lidhja', {})).data.field === 'email', 'no address');
      assert((await team('lidhja', { email: TEAM[0] }, { origin: 'https://evil.example' })).status === 403, 'cross-site');
      assert((await team('lidhja', `email=${TEAM[0]}`, { type: 'application/x-www-form-urlencoded' })).status === 415, 'form post');
      assert((await team('lidhja', { email: TEAM[0], pad: 'x'.repeat(9000) })).status === 413, 'oversized');
      assert((await fetch(`${BASE}/api/admin/lidhja`)).status === 405, 'GET');
      assert((await fetch(`${BASE}/api/admin/hyr`)).status === 405, 'GET hyr');
      assert((await team('hyr', { token: 'x' }, { origin: 'https://evil.example' })).status === 403, 'hyr cross-site');
      await pause(1000);
      assert(linksTo(TEAM[0]).length === 3, 'an email went out');
    });
    await check('45. at most 5 links per network per 10 minutes and 20 a day: the only answer that differs, whatever the address', async () => {
      const ip = freshIp();
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await team('lidhja', { email: `askush${i}@rregullo.test` }, { ip })).status);
      const sixth = await team('lidhja', { email: TEAM[2] }, { ip });
      assert(codes.every((c) => c === 200) && sixth.status === 429 && sixth.data.message.includes('shumë'), `${codes.join()},${sixth.status}`);
      assert((await team('lidhja', { email: 'askush@rregullo.test' })).status === 200, 'another network refused');
      const daily = freshIp();
      const bucket = await hmac(SECRET, 'admin-ip', `${daily}|${Math.floor(Date.now() / 86400000)}`);
      const old = Date.now() - 11 * 60 * 1000;
      sql(`INSERT INTO rate_events (bucket, at) VALUES ${Array.from({ length: 20 }, (_, i) => `('${bucket}', ${old - i * 1000})`).join(', ')}`);
      assert((await team('lidhja', { email: TEAM[2] }, { ip: daily })).status === 429, '21st of the day');
      await pause(1000);
      assert(linksTo(TEAM[2]).length === 0, 'a refused request sent a link');
    });
    let ekipi1 = '';
    await check('46. the link signs in once: an HttpOnly, SameSite=Strict cookie for 7 days; the same link again is refused', async () => {
      const m = linksTo(TEAM[0]).at(-1);
      const r = await team('hyr', { token: tokenOf(m) });
      assert(r.status === 200 && r.data.ok, JSON.stringify(r.data));
      assert(/^rr_ekipi=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800$/.test(r.setCookie), r.setCookie);
      ekipi1 = cookieOf(r.setCookie);
      const rows = sql("SELECT subject, expires_at - created_at AS ttl FROM sessions WHERE kind = 'admin'");
      assert(rows.length === 1 && rows[0].subject === TEAM[0] && rows[0].ttl === 7 * 86400000, JSON.stringify(rows));
      assert(!JSON.stringify(sql('SELECT token_hash FROM sessions')).includes(ekipi1.split('=')[1]), 'raw token stored');
      const again = await team('hyr', { token: tokenOf(m) });
      assert(again.status === 400 && again.data.expired && !again.setCookie, JSON.stringify(again.data));
      // The code from the used link doesn't open it either.
      const viaCode = await team('hyr', { email: TEAM[0], code: codeOf(m) });
      assert(viaCode.status === 400 && viaCode.data.field === 'code' && !viaCode.setCookie, JSON.stringify(viaCode.data));
      for (const token of ['', 'x', 'A'.repeat(43), `${tokenOf(m)}x`, 42, null]) {
        const bad = await team('hyr', { token });
        assert(bad.status === 400 && bad.data.expired, `${JSON.stringify(token)} → ${bad.status}`);
      }
      const who = await team('une', undefined, { cookie: ekipi1 });
      assert(who.status === 200 && who.data.email === TEAM[0] && who.data.smsEnabled === true && who.data.photosEnabled === true, JSON.stringify(who.data));
      assert((await team('une')).status === 401, 'no cookie');
      assert((await team('une', undefined, { cookie: `rr_ekipi=${'A'.repeat(43)}` })).status === 401, 'made-up cookie');
    });
    await check('47. a link older than 15 minutes: neither its token nor its code signs in', async () => {
      const { token, code } = await newLink(TEAM[2]);
      sql(`UPDATE admin_links SET expires_at = ${Date.now() - 1} WHERE email = '${TEAM[2]}'`);
      const r = await team('hyr', { token });
      assert(r.status === 400 && r.data.expired && !r.setCookie, JSON.stringify(r.data));
      const c = await team('hyr', { email: TEAM[2], code });
      assert(c.status === 400 && c.data.field === 'code' && !c.setCookie, JSON.stringify(c.data));
    });
    let ekipi2 = '';
    await check("48. the code signs in instead of the link and uses it up; five wrong tries end that link's code", async () => {
      const { token, code } = await newLink(TEAM[1]);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 4; i++) {
        const r = await team('hyr', { email: TEAM[1], code: wrong });
        assert(r.status === 400 && r.data.field === 'code' && r.data.message === 'Kodi nuk është i saktë.' && !r.setCookie, `try ${i + 1}: ${JSON.stringify(r.data)}`);
      }
      // The fifth try, typed with spaces and capitals, is the right one.
      const r = await team('hyr', { email: ' Ekipi2@Rregullo.test ', code: `${code.slice(0, 3)} ${code.slice(3)}` });
      assert(r.status === 200 && /^rr_ekipi=[A-Za-z0-9_-]{43};/.test(r.setCookie), JSON.stringify(r.data));
      ekipi2 = cookieOf(r.setCookie);
      assert((await team('une', undefined, { cookie: ekipi2 })).data.email === TEAM[1], 'signed in as someone else');
      assert((await team('hyr', { token })).data.expired, 'the link still works after its code was used');
      assert((await team('hyr', { email: TEAM[1], code })).status === 400, 'the code worked twice');

      const other = await newLink(TEAM[3]);
      const wrong4 = other.code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) assert((await team('hyr', { email: TEAM[3], code: wrong4 })).status === 400, `try ${i + 1}`);
      const late = await team('hyr', { email: TEAM[3], code: other.code });
      assert(late.status === 400 && late.data.field === 'code' && !late.setCookie, 'the right code worked after five wrong ones');
      assert(sql(`SELECT attempts FROM admin_links WHERE email = '${TEAM[3]}'`)[0].attempts === 5, 'attempts');
      // An address outside the team, and codes that aren't 6 digits: the same answer as a wrong code.
      const refused = late.data;
      for (const [email, c] of [['askush@rregullo.test', '123456'], [TEAM[3], '12345'], [TEAM[3], 'abcdef'], [TEAM[3], ''], [TEAM[3], 1234567]]) {
        const x = await team('hyr', { email, code: c });
        assert(x.status === 400 && JSON.stringify(x.data) === JSON.stringify(refused), `${email} ${c} → ${x.status} ${JSON.stringify(x.data)}`);
      }
      assert((await team('hyr', { email: 'ekipi', code: '123456' })).data.field === 'email', 'malformed address');
    });
    let ekipi3 = '';
    await check('49. 20 code tries per address a day: after that even the right code is refused, while the link still works', async () => {
      const { token, code } = await newLink(TEAM[2]);
      const bucket = await hmac(SECRET, 'admin-code-tries', TEAM[2]);
      const now = Date.now();
      sql(`INSERT INTO rate_events (bucket, at) VALUES ${Array.from({ length: 20 }, (_, i) => `('${bucket}', ${now - 1000 - i})`).join(', ')}`);
      const r = await team('hyr', { email: TEAM[2], code });
      assert(r.status === 400 && r.data.field === 'code' && !r.setCookie, JSON.stringify(r.data));
      const viaLink = await team('hyr', { token });
      assert(viaLink.status === 200, `link → ${viaLink.status}`);
      ekipi3 = cookieOf(viaLink.setCookie);
    });

    console.log('Team admin: sessions');
    let arben = '';
    await check("50. the two cookies never cross: a mjeshtër's session can't use the team API, a team session can't use the mjeshtër's", async () => {
      arben = await newPro('044 400 500');
      const proToken = arben.split('=')[1];
      const teamToken = ekipi1.split('=')[1];
      for (const c of [arben, `rr_ekipi=${proToken}`]) {
        const r = await team('une', undefined, { cookie: c });
        assert(r.status === 401 && r.data.signedOut, `${c.split('=')[0]} → ${r.status}`);
        assert((await team('mjeshtrit', { status: 'all' }, { cookie: c })).status === 401, 'list');
        assert((await team('shto', { phone: '044 400 777', consent: true }, { cookie: c })).status === 401, 'add');
      }
      for (const c of [ekipi1, `rr_mjeshtri=${teamToken}`]) {
        const r = await me(c);
        assert(r.status === 401 && r.data.signedOut, `${c.split('=')[0]} on the mjeshtër API → ${r.status}`);
        assert((await api('/api/mjeshtri/profili', FULL, { cookie: c })).status === 401, 'mjeshtër profile');
      }
      assert(sql("SELECT COUNT(*) AS n FROM pros WHERE phone = '+38344400777'")[0].n === 0, 'added anyway');
    });
    await check('51. every team action needs a session, comes from this site, and uses the right method', async () => {
      const posts = [['mjeshtrit', { status: 'all' }], ['vendim', { id: 'x', action: 'verify' }], ['profili', { id: 'x', ...FULL }], ['foto/fshi', { id: 'x', photoId: 'y' }],
        ['shto', { phone: '044 400 777', consent: true }], ['fshi', { id: 'x', confirm: 'FSHIJE' }]];
      for (const [path, body] of posts) {
        const r = await team(path, body);
        assert(r.status === 401 && r.data.signedOut, `${path} without a session → ${r.status}`);
        assert((await team(path, body, { cookie: ekipi1, origin: 'https://evil.example' })).status === 403, `${path} cross-site`);
        assert((await team(path, JSON.stringify(body), { cookie: ekipi1, type: 'text/plain' })).status === 415, `${path} as text/plain`);
        assert((await request(`${BASE}/api/admin/${path}`, { headers: { Cookie: ekipi1 } })).status === 405, `${path} GET`);
      }
      for (const path of ['une', 'mjeshtri?id=x']) {
        const r = await team(path);
        assert(r.status === 401 && r.data.signedOut, `${path} without a session → ${r.status}`);
        assert((await team(path, {}, { cookie: ekipi1 })).status === 405, `POST ${path}`);
      }
      assert((await fetch(`${BASE}/api/admin/dil`)).status === 405, 'GET dil');
      assert((await teamUpload('x', 'pune', JPEG)).status === 401, 'upload without a session');
      assert((await teamUpload('x', 'pune', JPEG, { cookie: ekipi1, origin: 'https://evil.example' })).status === 403, 'upload cross-site');
      assert((await teamUpload('x', 'pune', JPEG, { cookie: ekipi1, type: 'multipart/form-data; boundary=x' })).status === 415, 'upload as a form');
      // A page on http://<this host> is another origin; wrangler dev rewrites Origin, so the handlers are called directly.
      const admin = await import('../functions/api/admin.js');
      for (const [name, path, init] of [['lidhja', 'lidhja', { body: '{}' }], ['hyr', 'hyr', { body: '{}' }], ['dil', 'dil', { body: '{}' }],
        ['vendim', 'vendim', { body: '{}' }], ['shto', 'shto', { body: '{}' }], ['foto', 'foto?id=x&lloji=pune', { body: JPEG, type: 'image/jpeg' }]]) {
        const res = await admin[name].onRequestPost({
          request: new Request(`https://rregullo.net/api/admin/${path}`, { method: 'POST', headers: { Origin: 'http://rregullo.net', 'Content-Type': init.type || 'application/json' }, body: init.body }),
          env: {}, waitUntil() {},
        });
        assert(res.status === 403, `${name} from http → ${res.status}`);
      }
      assert(sql("SELECT COUNT(*) AS n FROM pros WHERE phone = '+38344400777'")[0].n === 0, 'added anyway');
    });
    await check('52. signing out: cookie cleared, session deleted, the old cookie no longer works, other sessions stay', async () => {
      const { token } = await newLink(TEAM[0]);
      const extra = cookieOf((await team('hyr', { token })).setCookie);
      assert((await team('une', undefined, { cookie: extra })).status === 200, 'not signed in');
      const r = await team('dil', {}, { cookie: extra });
      assert(r.status === 200 && /^rr_ekipi=;/.test(r.setCookie) && /Max-Age=0/.test(r.setCookie) && /SameSite=Strict/.test(r.setCookie), r.setCookie);
      assert((await team('une', undefined, { cookie: extra })).status === 401, 'still signed in');
      assert((await team('une', undefined, { cookie: ekipi1 })).status === 200, 'another session ended');
      assert(sql(`SELECT COUNT(*) AS n FROM sessions WHERE kind = 'admin' AND subject = '${TEAM[0]}'`)[0].n === 1, 'session left');
    });
    await check('53. live site: Secure cookie; removing an address from ADMIN_EMAILS locks it out at once; no link without email settings; SMS off', async () => {
      const { getPlatformProxy } = await import('wrangler');
      const admin = await import('../functions/api/admin.js');
      const proxy = await getPlatformProxy({ persist: false });
      try {
        const db = proxy.env.DB;
        await applyMigrations(db);
        const live = { DB: db, SITE_URL: 'https://rregullo.net', APP_SECRET: SECRET, ADMIN_EMAILS: `${TEAM[0]}, ${TEAM[3]}`, RESEND_API_KEY: 're_test', EMAIL_FROM: 'Rregullo <njoftime@rregullo.net>', EMAIL_API_BASE: MOCK };
        const removed = { ...live, ADMIN_EMAILS: TEAM[0] };
        const pending = [];
        const call = (mod, env, path, { body, cookie: c = '', origin = 'https://rregullo.net' } = {}) => {
          const post = body !== undefined;
          return mod[post ? 'onRequestPost' : 'onRequestGet']({
            env, waitUntil: (p) => pending.push(p),
            request: new Request(`https://rregullo.net/api/admin/${path}`, {
              method: post ? 'POST' : 'GET',
              headers: { ...(post ? { 'Content-Type': 'application/json', Origin: origin } : {}), 'CF-Connecting-IP': freshIp(), ...(c ? { Cookie: c } : {}) },
              body: post ? JSON.stringify(body) : undefined,
            }),
          });
        };
        const settle = async () => { while (pending.length) await pending.shift(); };
        assert((await call(admin.lidhja, { ...live, RESEND_API_KEY: '' }, 'lidhja', { body: { email: TEAM[3] } })).status === 503, 'no email key');
        const before = linksTo(TEAM[3]).length;
        assert((await call(admin.lidhja, live, 'lidhja', { body: { email: TEAM[3] } })).status === 200, 'link');
        await settle();
        assert(linksTo(TEAM[3]).length === before + 1, 'no link sent');
        const m = linksTo(TEAM[3]).at(-1);
        assert(m.text.includes(`https://rregullo.net/admin/#hyr=${tokenOf(m)}`) && m.from === 'Rregullo <njoftime@rregullo.net>', m.text);
        const r = await call(admin.hyr, live, 'hyr', { body: { token: tokenOf(m) } });
        const set = r.headers.get('Set-Cookie') || '';
        assert(r.status === 200 && /^rr_ekipi=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800$/.test(set), set);
        const c = cookieOf(set);
        assert((await call(admin.une, live, 'une', { cookie: c })).status === 200, 'not signed in');
        // The address leaves the team: its session stops working on the next request, everywhere.
        const out = await call(admin.une, removed, 'une', { cookie: c });
        assert(out.status === 401 && (await out.json()).signedOut, `une → ${out.status}`);
        assert((await call(admin.mjeshtrit, removed, 'mjeshtrit', { cookie: c, body: { status: 'all' } })).status === 401, 'list');
        assert((await call(admin.vendim, removed, 'vendim', { cookie: c, body: { id: 'x', action: 'verify' } })).status === 401, 'decision');
        // A link sent before the removal no longer signs in, and no new one is sent.
        assert((await call(admin.lidhja, live, 'lidhja', { body: { email: TEAM[3] } })).status === 200, 'second link');
        await settle();
        const m2 = linksTo(TEAM[3]).at(-1);
        assert(m2 !== m, 'no second link');
        const gone = await call(admin.hyr, removed, 'hyr', { body: { token: tokenOf(m2) } });
        assert(gone.status === 400 && (await gone.json()).expired, `removed address signed in: ${gone.status}`);
        const goneCode = await call(admin.hyr, removed, 'hyr', { body: { email: TEAM[3], code: codeOf(m2) } });
        assert(goneCode.status === 400, `removed address signed in by code: ${goneCode.status}`);
        const count = linksTo(TEAM[3]).length;
        const asked = await call(admin.lidhja, removed, 'lidhja', { body: { email: TEAM[3] } });
        assert(asked.status === 200, `removed address → ${asked.status}`);
        await settle();
        assert(linksTo(TEAM[3]).length === count, 'a link went to a removed address');
        // Without the SMS settings a decision still goes through and says so.
        await db.prepare(`INSERT INTO pros (id, phone, name, trades, towns, status, created_at, updated_at, submitted_at)
          VALUES ('live-1', '+38344900111', 'Arta Live', '["hidraulik"]', '["prishtine"]', 'pending', 1, 1, 1)`).run();
        const ok = await call(admin.vendim, live, 'vendim', { cookie: c, body: { id: 'live-1', action: 'approve', seenEditedAt: null } });
        const data = await ok.json();
        assert(ok.status === 200 && data.sms === 'off' && data.pro.status === 'approved', JSON.stringify(data));
        // Two team members decide at the same moment (wrangler dev answers one request at a time, so decide() is
        // called directly): one change wins, the other is told the profile moved on, and only one is recorded.
        const { decide: decideNow, loadPro, readAdminConfig } = await import('../server/admin.js');
        await db.prepare(`INSERT INTO pros (id, phone, name, trades, towns, status, created_at, updated_at, submitted_at)
          VALUES ('live-2', '+38344900112', 'Besnik Live', '["hidraulik"]', '["prishtine"]', 'pending', 1, 1, 1)`).run();
        const cfg = readAdminConfig(live);
        const now = Date.now();
        const seenBoth = await loadPro(cfg, 'live-2', now);
        const race = await Promise.all([
          decideNow(cfg, TEAM[0], seenBoth, { action: 'approve', note: '', internalNote: '', notify: false, seenEditedAt: null }, now),
          decideNow(cfg, TEAM[3], seenBoth, { action: 'approve', note: '', internalNote: '', notify: false, seenEditedAt: null }, now),
        ]);
        assert(race.map((x) => x.result).sort().join() === 'ok,state', JSON.stringify(race));
        const logged = await db.prepare("SELECT COUNT(*) AS n FROM admin_log WHERE pro_id = 'live-2'").first();
        assert(logged.n === 1, `${logged.n} history rows`);
      } finally {
        await proxy.dispose();
      }
    });

    console.log('Team admin: the lists');
    const DAY = 86400000;
    await check('54. the lists: counts for every filter; pending oldest first, the others last changed first; what each row carries', async () => {
      const now = Date.now();
      sql(`INSERT INTO pros (id, phone, name, trades, towns, status, verified, created_at, updated_at, submitted_at, approved_at, edited_at) VALUES
        ('test-l1', '+38349111001', 'Çerkez  Shala', '["elektricist"]', '["prizren"]', 'pending', 0, ${now - 10 * DAY}, ${now - 3 * DAY}, ${now - 3 * DAY}, NULL, ${now - 3 * DAY}),
        ('test-l2', '+38344555666', 'Agim Berisha', '["hidraulik"]', '["prishtine","peje"]', 'pending', 1, ${now - 10 * DAY}, ${now - 1000}, ${now - 5 * DAY}, NULL, NULL),
        ('test-l3', '+38349111003', 'Driton Morina', '["hidraulik"]', '["peje"]', 'approved', 0, ${now - 20 * DAY}, ${now - 4 * DAY}, ${now - 15 * DAY}, ${now - 12 * DAY}, ${now - 13 * DAY}),
        ('test-l4', '+38349111004', 'Blerim Hoxha', '["elektricist"]', '["prishtine"]', 'approved', 0, ${now - 20 * DAY}, ${now - 2 * DAY}, ${now - 15 * DAY}, ${now - 10 * DAY}, ${now - 2 * DAY}),
        ('test-l5', '+38349111005', 'Gëzim Krasniqi', '["hidraulik"]', '["prizren"]', 'rejected', 0, ${now - 20 * DAY}, ${now - 6 * DAY}, ${now - 8 * DAY}, NULL, NULL)`);
      const list = (q) => team('mjeshtrit', Object.fromEntries(new URLSearchParams(q)), { cookie: ekipi1 });
      const all = await list('?status=all');
      assert(all.status === 200 && all.data.truncated === false, JSON.stringify(all.data).slice(0, 200));
      const by = Object.fromEntries(sql('SELECT status, COUNT(*) AS n FROM pros GROUP BY status').map((r) => [r.status, r.n]));
      const changed = sql("SELECT COUNT(*) AS n FROM pros WHERE status = 'approved' AND edited_at > approved_at")[0].n;
      const expected = { pending: by.pending || 0, approved: by.approved || 0, rejected: by.rejected || 0, suspended: by.suspended || 0, draft: by.draft || 0, changed, reported: 0, all: Object.values(by).reduce((a, b) => a + b, 0) };
      assert(JSON.stringify(all.data.counts) === JSON.stringify(expected), `${JSON.stringify(all.data.counts)} vs ${JSON.stringify(expected)}`);
      assert(all.data.items.length === expected.all, `${all.data.items.length} rows`);
      assert(JSON.stringify((await list('')).data) === JSON.stringify(all.data), 'no filter is not "all"');
      const desc = (items) => items.every((x, i) => i === 0 || items[i - 1].updatedAt >= x.updatedAt);
      assert(desc(all.data.items), 'all: not last changed first');

      const pending = (await list('?status=pending')).data.items;
      assert(pending.every((x) => x.status === 'pending') && pending.length === expected.pending, 'pending');
      assert(pending.every((x, i) => i === 0 || pending[i - 1].submittedAt <= x.submittedAt), 'pending: not oldest first');
      assert(pending.findIndex((x) => x.id === 'test-l2') < pending.findIndex((x) => x.id === 'test-l1'), 'the longest wait is not first');
      const row = pending.find((x) => x.id === 'test-l2');
      assert(row.name === 'Agim Berisha' && row.phone === '+383 44 555 666' && row.verified === true && row.photo === null && row.trades.join() === 'hidraulik' && row.towns.join() === 'prishtine,peje' && row.submittedAt === now - 5 * DAY && row.editedAt === null && row.changedSinceApproval === false, JSON.stringify(row));

      const approved = (await list('?status=approved')).data.items;
      assert(approved.every((x) => x.status === 'approved') && desc(approved), 'approved');
      assert(approved.find((x) => x.id === 'test-l4').changedSinceApproval === true && approved.find((x) => x.id === 'test-l3').changedSinceApproval === false, 'changed since approval');
      const ch = (await list('?status=changed')).data.items;
      assert(ch.map((x) => x.id).join() === 'test-l4', `changed: ${ch.map((x) => x.id)}`);
      for (const status of ['rejected', 'suspended', 'draft']) {
        const items = (await list(`?status=${status}`)).data.items;
        assert(items.length === expected[status] && items.every((x) => x.status === status) && desc(items), status);
      }
      for (const bad of ['?status=deleted', '?status=', '?status=PENDING']) {
        const r = await list(bad);
        assert(bad === '?status=' ? r.status === 200 : (r.status === 400 && r.data.field === 'status'), `${bad} → ${r.status}`);
      }
    });
    await check('55. search: the name without accents or capitals, the phone in any form; % and _ are plain characters', async () => {
      const ids = async (q, status = 'all') => {
        const r = await team('mjeshtrit', { status, q }, { cookie: ekipi1 });
        assert(r.status === 200, `${q} → ${r.status}`);
        return r.data.items.map((x) => x.id).sort().join();
      };
      for (const q of ['cerkez', 'ÇERKEZ', 'çerkez shala', '  Cerkez   Shala ']) assert(await ids(q) === 'test-l1', `${q} → ${await ids(q)}`);
      assert(await ids('gezim') === 'test-l5' && await ids('GËZIM') === 'test-l5', 'ë');
      for (const q of ['044 555 666', '+383 44 555 666', '0038344555666', '38344555666', '044555666', '555 66']) assert(await ids(q) === 'test-l2', `${q} → ${await ids(q)}`);
      for (const q of ['%', '_', '%%', 'a_im', '44', 'zzz']) assert(await ids(q) === '', `${q} matched ${await ids(q)}`);
      assert(await ids('a', 'pending') !== '' && !(await ids('a', 'pending')).includes('test-l5'), 'search outside the filter');
      assert(await ids('cerkez', 'approved') === '', 'search ignores the filter');
      // Only the first 60 characters count.
      assert(await ids(`${'Çerkez Shala'.padEnd(60)}zzz`) === 'test-l1', 'longer than 60');
    });

    console.log('Team admin: decisions');
    let arbenId = '';
    const detail = async (id, c = ekipi1) => (await team(`mjeshtri?id=${encodeURIComponent(id)}`, undefined, { cookie: c })).data.pro;
    const decide = (id, action, extra = {}, c = ekipi1) => team('vendim', { id, action, ...extra }, { cookie: c });
    await check('56. one mjeshtër in full; approving an incomplete profile is refused with what is missing', async () => {
      arbenId = proId('+38344400500');
      assert((await api('/api/mjeshtri/profili', { name: 'Arben' }, { cookie: arben })).status === 200, 'save');
      const p = await detail(arbenId);
      assert(p.id === arbenId && p.phone === '+383 44 400 500' && p.phoneE164 === '+38344400500' && p.status === 'draft' && p.profile.name === 'Arben', JSON.stringify(p));
      assert(p.editedAt > 0 && p.lastLoginAt > 0 && p.createdAt > 0 && p.approvedAt === null && p.changedSinceApproval === false && Array.isArray(p.log) && p.log.length === 0, JSON.stringify(p));
      assert(p.checklist && p.photos && p.stats && p.photosEnabled === true && p.verified === false, 'shape');
      const before = sms.length;
      const r = await decide(arbenId, 'approve', { seenEditedAt: p.editedAt });
      assert(r.status === 400 && r.data.missing.join() === 'trades,towns,photo', JSON.stringify(r.data));
      assert(sql(`SELECT status FROM pros WHERE id = '${arbenId}'`)[0].status === 'draft' && sms.length === before, 'changed anyway');
      for (const id of ['nope', "x' OR 1=1 --", '', 'a'.repeat(65)]) {
        const res = await team(`mjeshtri?id=${encodeURIComponent(id)}`, undefined, { cookie: ekipi1 });
        assert(res.status === 404 && res.data.message.includes('nuk u gjet'), `${id} → ${res.status}`);
      }
      assert((await decide('nope', 'approve', { seenEditedAt: null })).status === 404, 'unknown id');
    });
    let besa = '';
    await check('57. a mjeshtër sends the profile: each team address gets one email, at most one an hour, with no name or number', async () => {
      assert((await api('/api/mjeshtri/profili', FULL, { cookie: arben })).status === 200, 'save');
      assert((await upload('profili', JPEG, { cookie: arben })).status === 200, 'photo');
      const hour = Math.floor(Date.now() / 3600000);
      // Test 33 already sent this hour's email.
      sql(`DELETE FROM rate_events WHERE bucket = '${await hmac(SECRET, 'admin-queue', String(hour))}'`);
      const before = mock.messages.length;
      const r = await api('/api/mjeshtri/dergo', {}, { cookie: arben });
      assert(r.status === 200 && r.data.dashboard.status === 'pending', JSON.stringify(r.data));
      const queue = () => mock.messages.slice(before).filter((m) => m.subject === QUEUE_SUBJECT);
      await until(() => queue().length >= TEAM.length, 'the team emails');
      await pause(500);
      const sent = queue();
      assert(sent.length === TEAM.length && TEAM.every((a) => sent.filter((m) => m.to.includes(a)).length === 1), sent.map((m) => m.to).join());
      const waiting = sql("SELECT COUNT(*) AS n FROM pros WHERE status = 'pending'")[0].n;
      for (const m of sent) {
        assert(m.text.includes(`${BASE}/admin/#lista`) && m.text.includes(`Në pritje tani: ${waiting} profile`), m.text);
        assert(/^queue-\d+-[0-9a-f]{16}$/.test(m.idempotencyKey), m.idempotencyKey);
        const all = `${m.subject} ${m.text} ${m.html}`;
        for (const secret of ['Arben', 'Krasniqi', '400 500', '400500', arbenId]) assert(!all.includes(secret), `the email names the mjeshtër (${secret})`);
      }
      assert(new Set(sent.map((m) => m.idempotencyKey)).size === TEAM.length, 'one key for several recipients');
      // Another mjeshtër sends a profile within the hour: no new email.
      besa = await newPro('044 400 501');
      assert((await api('/api/mjeshtri/profili', { ...FULL, name: 'Besa Gashi' }, { cookie: besa })).status === 200, 'save');
      assert((await upload('profili', JPEG, { cookie: besa })).status === 200, 'photo');
      const count = mock.messages.length;
      assert((await api('/api/mjeshtri/dergo', {}, { cookie: besa })).data.dashboard.status === 'pending', 'send');
      await pause(1500);
      if (Math.floor(Date.now() / 3600000) === hour) assert(mock.messages.length === count, 'a second email within the hour');
    });
    await check('58. approving what the team saw: refused when the mjeshtër edited meanwhile; then approved, with one SMS', async () => {
      const seen = (await detail(arbenId)).editedAt;
      await pause(5);
      assert((await api('/api/mjeshtri/profili', { ...FULL, years: 16 }, { cookie: arben })).status === 200, 'edit');
      const before = sms.length;
      const stale = await decide(arbenId, 'approve', { seenEditedAt: seen });
      assert(stale.status === 409 && stale.data.reason === 'edited' && stale.data.message === 'Mjeshtri e ndryshoi profilin ndërkohë. Shikoje prapë.', JSON.stringify(stale.data).slice(0, 300));
      assert(stale.data.pro.editedAt > seen && stale.data.pro.status === 'pending' && stale.data.pro.profile.years === 16, 'not the fresh profile');
      for (const bad of [{}, { seenEditedAt: String(seen) }, { seenEditedAt: 1.5 }]) {
        const r = await decide(arbenId, 'approve', bad);
        assert(r.status === 400 && r.data.field === 'seenEditedAt', `${JSON.stringify(bad)} → ${r.status}`);
      }
      assert((await decide(arbenId, 'approve', { seenEditedAt: null })).status === 409, 'approved with editedAt null');
      const ok = await decide(arbenId, 'approve', { seenEditedAt: stale.data.pro.editedAt });
      assert(ok.status === 200 && ok.data.ok && ok.data.message === 'Profili u aprovua.' && ok.data.sms === 'sent', JSON.stringify(ok.data).slice(0, 300));
      const p = ok.data.pro;
      assert(p.status === 'approved' && p.approvedAt > 0 && p.statusNote === '' && p.changedSinceApproval === false, JSON.stringify(p).slice(0, 300));
      assert(p.log.length === 1 && p.log[0].action === 'approve' && p.log[0].admin === TEAM[0] && p.log[0].note === '' && p.log[0].publicNote === '' && p.log[0].at > 0, JSON.stringify(p.log));
      assert(sms.length === before + 1, `${sms.length - before} SMS`);
      const text = sms.at(-1);
      assert(text.To === '+38344400500' && text.Body === `Rregullo: Profili yt u aprovua. Klientet do te te gjejne sapo te hapet kerkimi. ${BASE}/mjeshtri`, JSON.stringify(text));
      assert(ascii160(text.Body), `not one plain SMS: ${text.Body}`);
      const d = (await me(arben)).data.dashboard;
      assert(d.status === 'approved' && d.statusNote === '', JSON.stringify(d).slice(0, 200));
    });
    await check('59. edits after approval: still approved, shown as changed; "seen" marks them checked; the switch is not an edit', async () => {
      const approvedAt = (await detail(arbenId)).approvedAt;
      await pause(5);
      assert((await api('/api/mjeshtri/profili', { ...FULL, years: 17 }, { cookie: arben })).status === 200, 'edit');
      let p = await detail(arbenId);
      assert(p.status === 'approved' && p.changedSinceApproval === true && p.editedAt > approvedAt, JSON.stringify(p).slice(0, 300));
      assert((await me(arben)).data.dashboard.status === 'approved', 'the mjeshtër lost the approval');
      const list = (await team('mjeshtrit', { status: 'changed' }, { cookie: ekipi1 })).data;
      assert(list.items.some((x) => x.id === arbenId && x.changedSinceApproval) && list.counts.changed === list.items.length, JSON.stringify(list.counts));
      const stale = await decide(arbenId, 'seen', { seenEditedAt: approvedAt });
      assert(stale.status === 409 && stale.data.reason === 'edited', `stale seen → ${stale.status}`);
      const ok = await decide(arbenId, 'seen', { seenEditedAt: p.editedAt });
      assert(ok.status === 200 && ok.data.message === 'Ndryshimet u shënuan si të kontrolluara.' && ok.data.sms === null, JSON.stringify(ok.data).slice(0, 200));
      p = ok.data.pro;
      assert(p.status === 'approved' && p.changedSinceApproval === false && p.approvedAt >= p.editedAt && p.log[0].action === 'seen', JSON.stringify(p).slice(0, 300));
      assert(!(await team('mjeshtrit', { status: 'changed' }, { cookie: ekipi1 })).data.items.some((x) => x.id === arbenId), 'still listed as changed');
      const seenPending = await decide('test-l1', 'seen', { seenEditedAt: (await detail('test-l1')).editedAt });
      assert(seenPending.status === 409 && seenPending.data.reason === 'state', `seen on pending → ${seenPending.status}`);
      assert((await api('/api/mjeshtri/disponueshem', { available: false }, { cookie: arben })).status === 200, 'switch');
      const after = await detail(arbenId);
      assert(after.editedAt === p.editedAt && !after.changedSinceApproval, 'the switch counted as an edit');
      await api('/api/mjeshtri/disponueshem', { available: true }, { cookie: arben });
    });
    await check('60. sent back for changes: needs a reason; the mjeshtër sees the reason, never the team\'s note; one SMS', async () => {
      const before = sms.length;
      for (const note of [undefined, '', 'ab', '  a  ', 'x'.repeat(301), 42]) {
        const r = await decide(arbenId, 'reject', { note });
        assert(r.status === 400 && r.data.field === 'note' && r.data.message.includes('3 deri në 300'), `${JSON.stringify(note)} → ${r.status}`);
      }
      const long = await decide(arbenId, 'reject', { note: 'Fotoja nuk duket.', internalNote: 'x'.repeat(301) });
      assert(long.status === 400 && long.data.field === 'internalNote', `internal note → ${long.status}`);
      assert(sql(`SELECT status FROM pros WHERE id = '${arbenId}'`)[0].status === 'approved', 'changed anyway');
      const r = await decide(arbenId, 'reject', { note: '  Fotoja e profilit nuk duket qartë.  ', internalNote: 'Foli me të në telefon të hënën.' });
      assert(r.status === 200 && r.data.message === 'Profili u kthye për ndryshime.' && r.data.sms === 'sent', JSON.stringify(r.data).slice(0, 300));
      assert(r.data.pro.status === 'rejected' && r.data.pro.statusNote === 'Fotoja e profilit nuk duket qartë.', JSON.stringify(r.data.pro).slice(0, 300));
      const l = r.data.pro.log[0];
      assert(l.action === 'reject' && l.admin === TEAM[0] && l.publicNote === 'Fotoja e profilit nuk duket qartë.' && l.note === 'Foli me të në telefon të hënën.', JSON.stringify(l));
      assert(sms.length === before + 1, `${sms.length - before} SMS`);
      const text = sms.at(-1);
      assert(text.To === '+38344400500' && text.Body === `Rregullo: Ekipi kerkon disa ndryshime ne profilin tend. Shiko arsyen: ${BASE}/mjeshtri` && ascii160(text.Body), JSON.stringify(text));
      const mine = await me(arben);
      assert(mine.data.dashboard.status === 'rejected' && mine.data.dashboard.statusNote === 'Fotoja e profilit nuk duket qartë.', JSON.stringify(mine.data.dashboard).slice(0, 200));
      const seenByPro = JSON.stringify(mine.data);
      assert(!seenByPro.includes('Foli me të') && !seenByPro.includes('rregullo.test'), 'the mjeshtër sees the team\'s note or address');
      assert(sql(`SELECT status_note FROM pros WHERE id = '${arbenId}'`)[0].status_note === 'Fotoja e profilit nuk duket qartë.', 'stored note');
    });
    await check('61. every allowed change and every refused one; verify, suspend and lift it; no SMS but for approve and reject', async () => {
      const before = sms.length;
      const notNow = (r, what) => assert(r.status === 409 && r.data.reason === 'state' && r.data.pro && r.data.pro.id === arbenId && r.data.message.includes('gjendjen'), `${what} → ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
      const edited = async () => (await detail(arbenId)).editedAt;
      // rejected
      notNow(await decide(arbenId, 'reject', { note: 'Prapë.' }), 'reject when rejected');
      notNow(await decide(arbenId, 'seen', { seenEditedAt: await edited() }), 'seen when rejected');
      notNow(await decide(arbenId, 'unsuspend'), 'unsuspend when rejected');
      const back = await decide(arbenId, 'approve', { seenEditedAt: await edited(), notify: false });
      assert(back.status === 200 && back.data.pro.status === 'approved' && back.data.sms === 'skipped', JSON.stringify(back.data).slice(0, 200));
      // approved
      notNow(await decide(arbenId, 'approve', { seenEditedAt: await edited() }), 'approve when approved');
      notNow(await decide(arbenId, 'unsuspend'), 'unsuspend when approved');
      // suspended
      const noNote = await decide(arbenId, 'suspend');
      assert(noNote.status === 400 && noNote.data.field === 'note', `suspend without a reason → ${noNote.status}`);
      const s = await decide(arbenId, 'suspend', { note: 'Ankesa nga klientët.', internalNote: 'Tre ankesa këtë javë.' });
      assert(s.status === 200 && s.data.message === 'Llogaria u pezullua.' && s.data.sms === null && s.data.pro.status === 'suspended' && s.data.pro.statusNote === 'Ankesa nga klientët.', JSON.stringify(s.data).slice(0, 200));
      const d = (await me(arben)).data.dashboard;
      assert(d.status === 'suspended' && d.statusNote === 'Ankesa nga klientët.', JSON.stringify(d).slice(0, 200));
      assert((await api('/api/mjeshtri/profili', FULL, { cookie: arben })).status === 403, 'a suspended mjeshtër can edit');
      notNow(await decide(arbenId, 'suspend', { note: 'Prapë.' }), 'suspend when suspended');
      notNow(await decide(arbenId, 'approve', { seenEditedAt: await edited() }), 'approve when suspended');
      notNow(await decide(arbenId, 'reject', { note: 'Prapë.' }), 'reject when suspended');
      notNow(await decide(arbenId, 'seen', { seenEditedAt: await edited() }), 'seen when suspended');
      // Verifikuar works in any status; saying it twice changes nothing.
      const v = await decide(arbenId, 'verify');
      assert(v.status === 200 && v.data.message === 'U shënua si i verifikuar.' && v.data.pro.verified === true && v.data.sms === null, JSON.stringify(v.data).slice(0, 200));
      const logged = v.data.pro.log.length;
      const v2 = await decide(arbenId, 'verify');
      assert(v2.status === 200 && v2.data.pro.verified === true && v2.data.pro.log.length === logged, 'verify twice');
      const u = await decide(arbenId, 'unverify');
      assert(u.status === 200 && u.data.message === 'Shenja Verifikuar u hoq.' && u.data.pro.verified === false, 'unverify');
      // Lifting the suspension: back in the queue when complete, a draft when not.
      const t0 = Date.now();
      const un = await decide(arbenId, 'unsuspend');
      assert(un.status === 200 && un.data.message === 'Pezullimi u hoq. Profili është në pritje të shqyrtimit.' && un.data.pro.status === 'pending' && un.data.pro.statusNote === '' && un.data.pro.submittedAt >= t0, JSON.stringify(un.data).slice(0, 300));
      const emptyId = proId('+38344200300');
      assert((await decide(emptyId, 'suspend', { note: 'Numër i gabuar.' })).data.pro.status === 'suspended', 'suspend a draft');
      const unDraft = await decide(emptyId, 'unsuspend');
      assert(unDraft.status === 200 && unDraft.data.pro.status === 'draft' && unDraft.data.message.includes('pa dërguar'), JSON.stringify(unDraft.data).slice(0, 200));
      // Unknown actions and fields.
      for (const action of ['delete', '', undefined, 'APPROVE']) {
        const r = await decide(arbenId, action);
        assert(r.status === 400 && r.data.field === 'action', `${action} → ${r.status}`);
      }
      assert((await decide('nope', 'delete')).status === 404, 'an unknown id is checked first');
      const history = (await detail(arbenId)).log;
      assert(history.map((x) => x.action).join() === 'unsuspend,unverify,verify,suspend,approve,reject,seen,approve', history.map((x) => x.action).join());
      assert(history.every((x) => x.admin === TEAM[0]), 'admin');
      const susp = history.find((x) => x.action === 'suspend');
      assert(susp.publicNote === 'Ankesa nga klientët.' && susp.note === 'Tre ankesa këtë javë.', JSON.stringify(susp));
      assert(sms.length === before, `${sms.length - before} SMS for actions that send none`);
    });
    await check('62. SMS caps: 3 a day per mjeshtër and 50 a day in all; the decision still goes through', async () => {
      const before = sms.length;
      // Arben has had two texts today (approve, reject); the third is sent, the fourth is not.
      const a = await decide(arbenId, 'approve', { seenEditedAt: (await detail(arbenId)).editedAt });
      assert(a.status === 200 && a.data.sms === 'sent', JSON.stringify(a.data).slice(0, 200));
      const r = await decide(arbenId, 'reject', { note: 'Shto foto të punëve.' });
      assert(r.status === 200 && r.data.sms === 'capped' && r.data.pro.status === 'rejected', JSON.stringify(r.data).slice(0, 200));
      assert(sms.length === before + 1, `${sms.length - before} SMS`);
      const all = await hmac(SECRET, 'notify-sms-all', 'all');
      const now = Date.now();
      sql(`INSERT INTO rate_events (bucket, at) VALUES ${Array.from({ length: 50 }, (_, i) => `('${all}', ${now - 1000 - i})`).join(', ')}`);
      const besaId = proId('+38344400501');
      const b = await decide(besaId, 'approve', { seenEditedAt: (await detail(besaId)).editedAt });
      assert(b.status === 200 && b.data.sms === 'capped' && b.data.pro.status === 'approved', JSON.stringify(b.data).slice(0, 200));
      assert(sms.length === before + 1, 'sent over the daily cap');
      sql(`DELETE FROM rate_events WHERE bucket = '${all}'`);
    });

    console.log('Team admin: adding and editing a mjeshtër');
    let addedId = '';
    await check('63. adding a mjeshtër: only with their OK, never twice; at most 20 a day per team member', async () => {
      const add = (body, c = ekipi1) => team('shto', body, { cookie: c });
      for (const consent of [undefined, false, 'true', 1]) {
        const r = await add({ phone: '044 400 600', consent });
        assert(r.status === 400 && r.data.field === 'consent' && r.data.message.includes('pëlqimin'), `${consent} → ${r.status}`);
      }
      for (const phone of ['', '12345', '+386 41 123 456']) {
        const r = await add({ phone, consent: true });
        assert(r.status === 400 && r.data.field === 'phone', `${phone} → ${r.status}`);
      }
      const exists = await add({ phone: '+383 44 400 500', consent: true });
      assert(exists.status === 409 && exists.data.id === arbenId && exists.data.message === 'Ky numër është tashmë në Rregullo.', JSON.stringify(exists.data));
      assert(sql("SELECT COUNT(*) AS n FROM pros WHERE phone = '+38344400600'")[0].n === 0, 'added without consent');
      const r = await add({ phone: '044 400 600', consent: true });
      assert(r.status === 201 && r.data.ok && r.data.id && r.data.message.includes('u shtua'), JSON.stringify(r.data));
      addedId = r.data.id;
      const [row] = sql(`SELECT id, status, last_login_at FROM pros WHERE phone = '+38344400600'`);
      assert(row.id === addedId && row.status === 'draft' && row.last_login_at === null, JSON.stringify(row));
      const p = await detail(addedId);
      assert(p.status === 'draft' && p.lastLoginAt === null && p.phone === '+383 44 400 600', JSON.stringify(p).slice(0, 200));
      assert(p.log.length === 1 && p.log[0].action === 'created' && p.log[0].admin === TEAM[0] && p.log[0].note === 'pëlqim i dhënë', JSON.stringify(p.log));
      const again = await add({ phone: '+38344400600', consent: true }, ekipi2);
      assert(again.status === 409 && again.data.id === addedId, 'added twice');
      const bucket = await hmac(SECRET, 'admin-add', TEAM[1]);
      const now = Date.now();
      sql(`INSERT INTO rate_events (bucket, at) VALUES ${Array.from({ length: 20 }, (_, i) => `('${bucket}', ${now - 1000 - i})`).join(', ')}`);
      const capped = await add({ phone: '044 400 601', consent: true }, ekipi2);
      assert(capped.status === 429 && capped.data.message.includes('nesër'), `21st → ${capped.status}`);
      assert(sql("SELECT COUNT(*) AS n FROM pros WHERE phone = '+38344400601'")[0].n === 0, 'added over the cap');
      assert((await add({ phone: '044 400 500', consent: true }, ekipi2)).status === 409, 'an existing number is still found over the cap');
      assert((await add({ phone: '044 400 601', consent: true }, ekipi3)).status === 201, 'the cap is per team member');
    });
    await check('64. the team fills in the profile and photos of another mjeshtër; text comes back exactly as typed, never as HTML', async () => {
      const NAME = "Valon Gashi & Djemtë's";
      const ABOUT = 'Punoj <b>pllaka</b> dhe banjo <script>alert(1)</script> me garanci për çdo punë që bëj, në Prishtinë.';
      const r = await team('profili', { id: addedId, ...FULL, name: NAME, about: ABOUT }, { cookie: ekipi2 });
      assert(r.status === 200 && r.data.message === 'U ruajt.' && r.data.pro.profile.name === NAME && r.data.pro.profile.about === ABOUT, JSON.stringify(r.data).slice(0, 300));
      assert(r.data.pro.editedAt > 0 && r.data.pro.log[0].action === 'profile' && r.data.pro.log[0].admin === TEAM[1], JSON.stringify(r.data.pro.log));
      const listed = (await team('mjeshtrit', { status: 'draft', q: 'valon' }, { cookie: ekipi1 })).data.items;
      assert(listed.length === 1 && listed[0].name === NAME, JSON.stringify(listed));
      const bad = await team('profili', { id: addedId, ...FULL, name: '<b>Valon</b>' }, { cookie: ekipi2 });
      assert(bad.status === 400 && bad.data.errors.name, JSON.stringify(bad.data));
      assert((await team('profili', { id: 'nope', ...FULL }, { cookie: ekipi2 })).status === 404, 'unknown id');
      // Photos
      const pic = await teamUpload(addedId, 'profili', JPEG, { cookie: ekipi2 });
      assert(pic.status === 200 && pic.data.photo && pic.data.pro.photos.profile.id === pic.data.photo.id, JSON.stringify(pic.data).slice(0, 200));
      assert((await request(`${BASE}${pic.data.photo.url}`)).status === 200, 'not served');
      const work = await teamUpload(addedId, 'pune', JPEG, { cookie: ekipi2 });
      assert(work.status === 200 && work.data.pro.photos.work.length === 1, `work → ${work.status}`);
      const extra = await teamUpload(addedId, 'pune', JPEG, { cookie: ekipi2 });
      const del = await team('foto/fshi', { id: addedId, photoId: extra.data.photo.id }, { cookie: ekipi2 });
      assert(del.status === 200 && del.data.pro.photos.work.length === 1, `delete → ${del.status}`);
      assert((await request(`${BASE}${extra.data.photo.url}`)).status === 404, 'deleted photo still served');
      // Another mjeshtër's photo can't be deleted through this one, and odd requests are refused.
      const arbensPhoto = (await detail(arbenId)).photos.profile;
      assert((await team('foto/fshi', { id: addedId, photoId: arbensPhoto.id }, { cookie: ekipi2 })).status === 404, "deleted someone else's photo");
      assert((await request(`${BASE}${arbensPhoto.url}`)).status === 200, "someone else's photo is gone");
      assert((await team('foto/fshi', { id: 'nope', photoId: arbensPhoto.id }, { cookie: ekipi2 })).status === 404, 'unknown mjeshtër');
      assert((await teamUpload(addedId, 'tjeter', JPEG, { cookie: ekipi2 })).status === 400, 'unknown kind');
      assert((await teamUpload('nope', 'pune', JPEG, { cookie: ekipi2 })).status === 404, 'upload for an unknown id');
      assert((await teamUpload(addedId, 'pune', Buffer.from('hello'), { cookie: ekipi2 })).status === 400, 'not a JPEG');
      const p = await detail(addedId);
      assert(p.log.map((x) => x.action).join() === 'photo,photo,photo,photo,profile,created', p.log.map((x) => x.action).join());
      assert(p.log[0].note === 'U fshi një foto.' && p.log.some((x) => x.note === 'Foto e profilit u ndërrua.') && p.log.some((x) => x.note === 'U shtua një foto pune.'), JSON.stringify(p.log));
      // Approved with an SMS to the number, then a team change shows as changed since approval.
      const before = sms.length;
      const ok = await decide(addedId, 'approve', { seenEditedAt: p.editedAt });
      assert(ok.status === 200 && ok.data.sms === 'sent' && sms.length === before + 1 && sms.at(-1).To === '+38344400600', JSON.stringify(ok.data).slice(0, 200));
      await pause(5);
      const later = await teamUpload(addedId, 'pune', JPEG, { cookie: ekipi1 });
      assert(later.status === 200 && later.data.pro.status === 'approved' && later.data.pro.changedSinceApproval === true && later.data.pro.editedAt > later.data.pro.approvedAt, JSON.stringify(later.data.pro).slice(0, 200));
      const gone = await team('foto/fshi', { id: addedId, photoId: later.data.photo.id }, { cookie: ekipi1 });
      assert(gone.status === 200 && gone.data.pro.status === 'approved' && gone.data.pro.photos.work.length === 1, 'delete after approval');
    });
    let valon = '';
    await check('65. the added mjeshtër signs in by SMS with that number and finds the profile the team made', async () => {
      valon = await newPro('044 400 600');
      const d = (await me(valon)).data.dashboard;
      assert(d.status === 'approved' && d.profile.name === "Valon Gashi & Djemtë's" && d.photos.profile && d.photos.work.length === 1, JSON.stringify(d).slice(0, 300));
      assert(sql("SELECT COUNT(*) AS n FROM pros WHERE phone = '+38344400600'")[0].n === 1, 'a second account');
      assert((await detail(addedId)).lastLoginAt > 0, 'last sign-in not shown');
      assert(!JSON.stringify(d).includes('rregullo.test') && !JSON.stringify(d).includes('pëlqim'), 'the team history reached the mjeshtër');
    });
    await check('66. deleting a mjeshtër: needs the word; profile, photos (R2 too), history and sessions are gone', async () => {
      const urls = sql(`SELECT id FROM pro_photos WHERE pro_id = '${addedId}'`).map((r) => `/foto/${r.id}.jpg`);
      assert(urls.length === 2, `${urls.length} photos`);
      for (const confirm of [undefined, 'fshije', 'FSHIJE ']) {
        const r = await team('fshi', { id: addedId, confirm }, { cookie: ekipi1 });
        assert(r.status === 400 && r.data.field === 'confirm', `${confirm} → ${r.status}`);
      }
      assert((await team('fshi', { id: 'nope', confirm: 'FSHIJE' }, { cookie: ekipi1 })).status === 404, 'unknown id');
      const r = await team('fshi', { id: addedId, confirm: 'FSHIJE' }, { cookie: ekipi1 });
      assert(r.status === 200 && r.data.kept === false && r.data.message === 'Llogaria e mjeshtrit u fshi bashkë me profilin dhe fotot.', JSON.stringify(r.data));
      for (const [table, col] of [['pros', 'id'], ['pro_photos', 'pro_id'], ['admin_log', 'pro_id'], ['sessions', 'subject']]) {
        assert(sql(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = '${addedId}'`)[0].n === 0, `${table} still has rows`);
      }
      for (const u of urls) assert((await request(`${BASE}${u}`)).status === 404, `${u} still served`);
      assert((await me(valon)).status === 401, 'still signed in');
      assert((await team(`mjeshtri?id=${addedId}`, undefined, { cookie: ekipi1 })).status === 404, 'still listed');
      assert((await me(arben)).status === 200, "someone else's account is affected");
    });
    await check('67. deleting a suspended mjeshtër: profile and photos gone; the number stays suspended with its history', async () => {
      const s = await decide(arbenId, 'suspend', { note: 'Numri u raportua.' });
      assert(s.status === 200 && s.data.pro.status === 'suspended', `suspend → ${s.status}`);
      // The team can still change a suspended profile.
      assert((await team('profili', { id: arbenId, ...FULL, years: 18 }, { cookie: ekipi1 })).status === 200, 'team edit when suspended');
      assert((await teamUpload(arbenId, 'pune', JPEG, { cookie: ekipi1 })).status === 200, 'team upload when suspended');
      const urls = sql(`SELECT id FROM pro_photos WHERE pro_id = '${arbenId}'`).map((r) => `/foto/${r.id}.jpg`);
      const logged = (await detail(arbenId)).log.length;
      const r = await team('fshi', { id: arbenId, confirm: 'FSHIJE' }, { cookie: ekipi2 });
      assert(r.status === 200 && r.data.kept === true && r.data.message === 'Profili dhe fotot u fshinë. Numri mbetet i pezulluar.', JSON.stringify(r.data));
      const [row] = sql(`SELECT name, trades, status, status_note FROM pros WHERE id = '${arbenId}'`);
      assert(row && row.name === '' && row.trades === '[]' && row.status === 'suspended' && row.status_note === 'Numri u raportua.', JSON.stringify(row));
      assert(sql(`SELECT COUNT(*) AS n FROM pro_photos WHERE pro_id = '${arbenId}'`)[0].n === 0, 'photos left');
      for (const u of urls) assert((await request(`${BASE}${u}`)).status === 404, `${u} still served`);
      const p = await detail(arbenId);
      assert(p.log.length === logged + 1 && p.log[0].action === 'deleted' && p.log[0].admin === TEAM[1], JSON.stringify(p.log.slice(0, 2)));
      assert(p.log.some((x) => x.action === 'reject' && x.note === 'Foli me të në telefon të hënën.'), 'history lost');
      assert((await me(arben)).status === 401, 'still signed in');
    });

    // ---------- step 4: the public directory ----------
    // BASE keeps the directory closed (wrangler.toml); OPEN is the same Worker, database and photos with DIRECTORY_OPEN=1.
    const get = async (url, { cookie: c = '' } = {}) => {
      const res = await request(url, { redirect: 'manual', headers: { 'CF-Connecting-IP': freshIp(), ...(c ? { Cookie: c } : {}) } });
      return { status: res.status, html: await res.text(), h: (k) => res.headers.get(k) || '' };
    };
    const cardsOf = (html) => [...html.matchAll(/<li class="dir-card" data-m="([^"]+)"/g)].map((m) => m[1]);
    const tap = (base, body, { ip = freshIp(), cookie: c = '', type = 'application/json' } = {}) => request(`${base}/api/numero`, {
      method: 'POST', headers: { 'Content-Type': type, Origin: base, 'CF-Connecting-IP': ip, ...(c ? { Cookie: c } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }).then((res) => res.status);
    const openMe = (c) => request(`${OPEN}/api/mjeshtri/une`, { headers: { Cookie: c } }).then((res) => res.json());
    const today = () => new Date().toISOString().slice(0, 10);
    const SOON = 'Lista e mjeshtrave hapet së shpejti.';
    const NOINDEX = '<meta name="robots" content="noindex">';
    const DRITA = { ...FULL, name: "Dritë O'Hara & Bijtë", about: 'Punoj si elektricist prej 10 vitesh. <script>alert(1)</script> </script><!-- Instalime dhe riparime.', trades: ['elektricist'], towns: ['gjilan', 'kamenice'], years: 10, priceNote: 'nga 15 €', whatsapp: true, viber: true };
    let drita = '';
    let dritaId = '';
    let dritaHandle = '';
    let dritaPath = '';

    console.log('Public directory: the address and the closed directory');
    await check('68. approving gives a profile its public address, which never changes; the dashboard shows it only once the directory is open', async () => {
      drita = await newPro('044 500 100');
      dritaId = proId('+38344500100');
      const saved = await api('/api/mjeshtri/profili', DRITA, { cookie: drita });
      assert(saved.status === 200 && saved.data.dashboard.profile.about === DRITA.about, JSON.stringify(saved.data).slice(0, 200));
      assert((await upload('profili', JPEG, { cookie: drita })).status === 200, 'photo');
      assert((await api('/api/mjeshtri/dergo', {}, { cookie: drita })).data.dashboard.status === 'pending', 'send');
      const p = await detail(dritaId);
      assert(p.publicPath === null && sql(`SELECT handle FROM pros WHERE id = '${dritaId}'`)[0].handle === null, 'an address before approval');
      const ok = await decide(dritaId, 'approve', { seenEditedAt: p.editedAt, notify: false });
      assert(ok.status === 200 && ok.data.pro.status === 'approved', JSON.stringify(ok.data).slice(0, 200));
      dritaHandle = sql(`SELECT handle FROM pros WHERE id = '${dritaId}'`)[0].handle;
      assert(/^[a-z2-9]{10}$/.test(dritaHandle), `handle ${dritaHandle}`);
      dritaPath = `/m/drite-o-hara-bijte-${dritaHandle}`;
      assert(ok.data.pro.publicPath === dritaPath, `team sees ${ok.data.pro.publicPath}`);
      // Closed: the mjeshtër isn't given an address nobody can open yet; open: it is there.
      const closed = (await me(drita)).data.dashboard;
      assert(closed.status === 'approved' && closed.publicPath === null, `closed: ${closed.publicPath}`);
      assert((await openMe(drita)).dashboard.publicPath === dritaPath, 'open: no address on the dashboard');
      // Sent back and approved again: the same address; none while not approved.
      const back = await decide(dritaId, 'reject', { note: 'Shto foto të punëve.', notify: false });
      assert(back.status === 200 && back.data.pro.publicPath === null, `rejected: ${back.data.pro && back.data.pro.publicPath}`);
      assert((await openMe(drita)).dashboard.publicPath === null, 'an address while rejected');
      const again = await decide(dritaId, 'approve', { seenEditedAt: back.data.pro.editedAt, notify: false });
      assert(again.status === 200 && again.data.pro.publicPath === dritaPath, `again: ${again.data.pro && again.data.pro.publicPath}`);
      assert(sql(`SELECT handle FROM pros WHERE id = '${dritaId}'`)[0].handle === dritaHandle, 'the handle changed');
    });
    await check('69. closed: the public sees "coming soon"; the signed-in team sees the real pages as a private, unindexed preview', async () => {
      for (const path of ['/kerko', '/kerko?zanati=elektricist&komuna=gjilan', dritaPath]) {
        for (const c of ['', drita]) {
          const r = await get(`${BASE}${path}`, { cookie: c });
          assert(r.status === 200 && r.html.includes(SOON) && !r.html.includes('Hoxha') && !r.html.includes("O'Hara") && !r.html.includes('dir-card'), `${path}${c ? ' (the mjeshtër)' : ''} → ${r.status}`);
        }
      }
      const s = await get(`${BASE}/kerko?zanati=elektricist&komuna=gjilan`, { cookie: ekipi1 });
      assert(s.status === 200 && cardsOf(s.html).join() === dritaHandle, `search → ${s.status} ${cardsOf(s.html)}`);
      const p = await get(`${BASE}${dritaPath}`, { cookie: ekipi1 });
      assert(p.status === 200 && p.html.includes("Dritë O'Hara &amp; Bijtë"), `profile → ${p.status}`);
      for (const [what, r] of [['search', s], ['profile', p]]) {
        assert(r.html.includes('<main class="dir" id="main" data-preview>') && r.html.includes('class="dir-preview"'), `${what}: no preview banner`);
        assert(r.html.includes(NOINDEX) && /noindex/.test(r.h('X-Robots-Tag')), `${what}: indexable`);
        assert(r.h('Cache-Control') === 'private, no-store', `${what}: Cache-Control ${r.h('Cache-Control')}`);
      }
      assert(!p.html.includes('application/ld+json') && !p.html.includes('og:title'), 'the preview carries share data');
    });
    await check('70. closed: /api/numero answers 204 and counts nothing, for anyone', async () => {
      for (const c of ['', ekipi1, besa]) {
        for (const lloji of ['shikim', 'thirrje', 'whatsapp', 'viber']) assert(await tap(BASE, { m: dritaHandle, lloji }, { cookie: c }) === 204, `${lloji} → not 204`);
      }
      assert(sql(`SELECT COUNT(*) AS n FROM pro_stats_daily WHERE pro_id = '${dritaId}'`)[0].n === 0, 'counted while closed');
    });

    console.log('Public directory: searching');
    // Bojaxhi in Viti: who is shown and in what order. Then 25 for Saldim in Mamushë, for the pages.
    const LONG = 'Lyej shtëpi, banesa dhe zyre me kujdes dhe pastërti, me ngjyra cilësore.';
    const dirRow = (key, name, o = {}) => {
      const r = { trades: '["bojaxhi"]', towns: '["viti"]', status: 'approved', available: 1, about: LONG, years: 5, verified: 0, whatsapp: 0, viber: 0, ...o };
      const t = Date.now() - 86400000;
      return `('test-d-${key}', '+3834980${String(dirRow.n++).padStart(4, '9')}', '${name}', '${r.about}', '${r.trades}', '${r.towns}', ${r.years === null ? 'NULL' : r.years}, ${r.whatsapp}, ${r.viber}, ${r.available}, '${r.status}', ${r.verified}, ${t}, ${t}, ${t}, ${t}, 'dtest${key.repeat(5)}')`;
    };
    dirRow.n = 1;
    const H = (key) => `dtest${key.repeat(5)}`;
    await check('71. a search lists only approved profiles of that trade and town: available first, then the more complete, then Verifikuar', async () => {
      const pages = 'abcdefghijklmnopqrstuvwxy'.split('').map((k) => dirRow(`p${k}`, `Saldim ${k.toUpperCase()}`, { trades: '["saldim"]', towns: '["mamushe"]' }));
      sql(`INSERT INTO pros (id, phone, name, about, trades, towns, years, whatsapp, viber, available, status, verified, created_at, updated_at, submitted_at, approved_at, handle) VALUES
        ${dirRow('k', 'Rend Kujtim', { verified: 1 })},
        ${dirRow('c', 'Rend Cena', { towns: '["prishtine","viti"]', whatsapp: 1 })},
        ${dirRow('b', 'Rend Bekim', { trades: '["murator","bojaxhi"]', about: '', years: null })},
        ${dirRow('a', 'Rend Agron', { available: 0 })},
        ${dirRow('d', 'Rend Dardan', { trades: '["murator"]' })},
        ${dirRow('e', 'Rend Erion', { towns: '["lipjan"]' })},
        ${dirRow('f', 'Rend Fatos', { status: 'pending' })},
        ${dirRow('g', 'Rend Gent', { status: 'draft' })},
        ${dirRow('h', 'Rend Hana', { status: 'rejected' })},
        ${dirRow('i', 'Rend Ilir', { status: 'suspended' })},
        ${pages.join(',\n')}`);
      const r = await get(`${OPEN}/kerko?zanati=bojaxhi&komuna=viti`);
      assert(r.status === 200 && !r.html.includes('data-preview') && !r.html.includes(NOINDEX) && !r.h('X-Robots-Tag'), `status ${r.status}`);
      // Kujtim and Cena: available and complete (Kujtim Verifikuar); Bekim: available, less complete; Agron: not available.
      assert(cardsOf(r.html).join() === ['k', 'c', 'b', 'a'].map(H).join(), cardsOf(r.html).join());
      assert(r.html.includes('<h1 class="dir-title" id="dir-title">Bojaxhi në Viti</h1>') && r.html.includes('>4 mjeshtër<'), 'title or count');
      assert(r.html.includes(`<link rel="canonical" href="${OPEN}/kerko?zanati=bojaxhi&amp;komuna=viti">`), 'canonical');
      assert(r.html.includes('<option value="bojaxhi" selected>') && r.html.includes('<option value="viti" selected>'), 'the form keeps the search');
      assert(r.html.includes('Tani për tani nuk merr punë') && r.html.includes('Merr punë tani') && r.html.includes('Verifikuar</span>'), 'availability or badge');
      const ids = async (q) => cardsOf((await get(`${OPEN}/kerko${q}`)).html).sort().join();
      assert(await ids('?zanati=bojaxhi') === ['a', 'b', 'c', 'e', 'k'].map(H).join(), `trade only: ${await ids('?zanati=bojaxhi')}`);
      assert(await ids('?komuna=viti') === ['a', 'b', 'c', 'd', 'k'].map(H).join(), `town only: ${await ids('?komuna=viti')}`);
      assert(await ids('?zanati=elektricist&komuna=kamenice') === dritaHandle, 'a profile with several towns');
    });
    await check('72. unknown search values are ignored; no results: the empty state with wider searches, never indexed', async () => {
      const odd = await get(`${OPEN}/kerko?zanati=nope&komuna=viti&faqja=abc`);
      assert(odd.status === 200 && cardsOf(odd.html).sort().join() === ['a', 'b', 'c', 'd', 'k'].map(H).join(), cardsOf(odd.html).join());
      assert(odd.html.includes('>Mjeshtër në Viti</h1>') && odd.html.includes(`<link rel="canonical" href="${OPEN}/kerko?komuna=viti">`), 'the unknown trade counted');
      const xss = await get(`${OPEN}/kerko?zanati=%3Cscript%3Ealert(1)%3C/script%3E&komuna=%22%3E%3Cb%3E&faqja=-1`);
      assert(xss.status === 200 && !xss.html.includes('alert(1)') && !xss.html.includes('"><b>') && xss.html.includes('>Gjej mjeshtër</h1>'), `status ${xss.status}`);
      const none = await get(`${OPEN}/kerko?zanati=kulmi&komuna=junik`);
      assert(none.status === 200 && cardsOf(none.html).length === 0 && none.html.includes('Ende nuk kemi mjeshtër për këtë kërkim.'), `status ${none.status}`);
      assert(none.html.includes('<a href="/kerko?zanati=kulmi">Kërko në gjithë Kosovën</a>') && none.html.includes('<a href="/kerko?komuna=junik">Shiko të gjitha zanatet në Junik</a>'), 'wider searches');
      assert(none.html.includes(NOINDEX) && /noindex/.test(none.h('X-Robots-Tag')), 'an empty search is indexable');
      assert((await request(`${OPEN}/kerko`, { method: 'POST', headers: { Origin: OPEN } })).status === 405, 'POST');
    });
    await check('73. results come 20 to a page; the pages link to each other and only the first is indexed', async () => {
      const q = '?zanati=saldim&komuna=mamushe';
      const p1 = await get(`${OPEN}/kerko${q}`);
      const p2 = await get(`${OPEN}/kerko${q}&faqja=2`);
      const c1 = cardsOf(p1.html);
      const c2 = cardsOf(p2.html);
      assert(c1.length === 20 && c2.length === 5 && new Set([...c1, ...c2]).size === 25 && [...c1, ...c2].every((h) => /^dtest(p[a-y]){5}$/.test(h)), `${c1.length} + ${c2.length}`);
      assert(p1.html.includes('25 mjeshtër, faqja 1 nga 2') && p1.html.includes('rel="next" href="/kerko?zanati=saldim&amp;komuna=mamushe&amp;faqja=2"') && !p1.html.includes('rel="prev"'), 'page 1 links');
      assert(p2.html.includes('rel="prev" href="/kerko?zanati=saldim&amp;komuna=mamushe"') && !p2.html.includes('rel="next"') && p2.html.includes('Faqja 2 nga 2'), 'page 2 links');
      assert(!p1.html.includes(NOINDEX) && p2.html.includes(NOINDEX), 'indexing');
      assert(cardsOf((await get(`${OPEN}/kerko${q}&faqja=99`)).html).join() === c2.join(), 'past the last page: not the last page');
      assert(cardsOf((await get(`${OPEN}/kerko${q}`)).html).join() === c1.join(), 'the order changes between requests');
    });

    console.log('Public directory: profiles');
    await check('74. a profile shows name, trades, towns and the contact links switched on; text is escaped everywhere', async () => {
      const r = await get(`${OPEN}${dritaPath}`);
      const html = r.html;
      assert(r.status === 200 && html.includes(`<h1 class="dir-profile-name">Dritë O'Hara &amp; Bijtë</h1>`), `status ${r.status}`);
      assert(html.includes('<p class="dir-trades">Elektricist</p>') && html.includes('<li>Punon në Gjilan, Kamenicë</li>') && html.includes('<li>10 vjet përvojë</li>') && html.includes('<li>nga 15 €</li>'), 'facts');
      assert(html.includes('href="tel:+38344500100"') && html.includes('href="https://wa.me/38344500100"') && html.includes('href="viber://chat?number=%2B38344500100"'), 'contact links');
      assert(/<img src="\/foto\/[0-9a-f-]{36}\.jpg"/.test(html), 'profile photo');
      assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &lt;/script&gt;&lt;!-- Instalime dhe riparime.'), 'about not escaped');
      assert(html.match(/<script\b/g).length === 2 && !html.includes('<!-- Instalime'), 'a script from the profile text');
      const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
      assert(!ld.includes('<'), `JSON-LD carries a raw <: ${ld.slice(0, 120)}`);
      const data = JSON.parse(ld);
      assert(data.name === DRITA.name && data.description === DRITA.about && data.telephone === '+38344500100' && data.url === `${OPEN}${dritaPath}`, JSON.stringify(data));
      assert(html.includes(`<link rel="canonical" href="${OPEN}${dritaPath}">`) && !html.includes(NOINDEX) && !r.h('X-Robots-Tag') && !html.includes('data-preview'), 'canonical or indexing');
      assert(html.includes(`data-m="${dritaHandle}"`) && html.includes('data-view'), 'counting hooks');
      // WhatsApp and Viber only when switched on.
      const none = (await get(`${OPEN}/m/rend-bekim-${H('b')}`)).html;
      assert(none.includes('href="tel:+') && !none.includes('wa.me') && !none.includes('viber://'), 'Bekim has neither');
      const wa = (await get(`${OPEN}/m/rend-cena-${H('c')}`)).html;
      assert(wa.includes('wa.me') && !wa.includes('viber://'), 'Cena has WhatsApp only');
    });
    await check('75. other addresses: a stale or capitalised name redirects; unknown, unapproved and suspended profiles are not found', async () => {
      for (const slug of [`emri-i-vjeter-${dritaHandle}`, dritaHandle, `drite-o-hara-bijte-${dritaHandle}`.toUpperCase(), `Drite-O-Hara-Bijte-${dritaHandle}`]) {
        const r = await get(`${OPEN}/m/${slug}`);
        assert(r.status === 301 && r.h('Location') === dritaPath, `${slug} → ${r.status} ${r.h('Location')}`);
      }
      for (const path of ['/m/askush-zzzzzzzzzz', '/m/x', `/m/rend-fatos-${H('f')}`, `/m/rend-gent-${H('g')}`, `/m/rend-hana-${H('h')}`, `/m/rend-ilir-${H('i')}`]) {
        const r = await get(`${OPEN}${path}`);
        assert(r.status === 404 && r.html.includes('Ky profil nuk u gjet.'), `${path} → ${r.status}`);
      }
      // Suspended by the team: gone from its address and from the search at once.
      const s = await decide('test-d-c', 'suspend', { note: 'Ankesa nga klientët.' });
      assert(s.status === 200 && s.data.pro.status === 'suspended', `suspend → ${s.status}`);
      assert((await get(`${OPEN}/m/rend-cena-${H('c')}`)).status === 404, 'a suspended profile is shown');
      assert(cardsOf((await get(`${OPEN}/kerko?zanati=bojaxhi&komuna=viti`)).html).join() === ['k', 'b', 'a'].map(H).join(), 'a suspended profile is listed');
    });

    console.log('Public directory: counting');
    await check('76. views and taps are counted per kind and day, once per network address; the Ballina shows them', async () => {
      const [ip1, ip2] = [freshIp(), freshIp()];
      for (const [lloji, ip] of [['shikim', ip1], ['shikim', ip1], ['shikim', ip2], ['thirrje', ip1], ['thirrje', ip1], ['whatsapp', ip1], ['viber', ip2], ['viber', ip2]]) {
        // A view answers 204; a tap on an approved profile answers 200 with the receipt reviews need (step 5).
        const want = lloji === 'shikim' ? 204 : 200;
        assert(await tap(OPEN, { m: dritaHandle, lloji }, { ip }) === want, `${lloji} → not ${want}`);
      }
      const [row] = sql(`SELECT views, calls, whatsapp, viber FROM pro_stats_daily WHERE pro_id = '${dritaId}' AND day = '${today()}'`);
      assert(row && row.views === 2 && row.calls === 1 && row.whatsapp === 1 && row.viber === 1, JSON.stringify(row));
      const s = (await me(drita)).data.dashboard.stats;
      assert(s.views === 2 && s.calls === 1 && s.whatsapp === 1 && s.viber === 1, JSON.stringify(s));
    });
    await check('77. nothing counted for unknown kinds or profiles, unapproved ones, the team, the mjeshtër themself, or past 300 a day from one address', async () => {
      const h = dritaHandle;
      for (const body of [{ m: h, lloji: 'email' }, { m: h, lloji: 'views' }, { m: h, lloji: '' }, { m: h }, { m: h.toUpperCase(), lloji: 'shikim' }, { m: 42, lloji: 'shikim' },
        { m: 'zzzzzzzzzz', lloji: 'shikim' }, { m: H('f'), lloji: 'shikim' }, { m: H('g'), lloji: 'thirrje' }, { m: H('h'), lloji: 'shikim' }, { m: H('i'), lloji: 'shikim' }, { m: H('c'), lloji: 'shikim' },
        '{"m":', 'x'.repeat(9000)]) {
        assert(await tap(OPEN, body) === 204, `${JSON.stringify(body).slice(0, 40)} → not 204`);
      }
      assert(await tap(OPEN, { m: h, lloji: 'shikim' }, { type: 'text/plain' }) === 204, 'text/plain');
      assert(await tap(OPEN, { m: h, lloji: 'shikim' }, { cookie: ekipi1 }) === 204, 'team');
      assert(await tap(OPEN, { m: h, lloji: 'thirrje' }, { cookie: drita }) === 204, 'own profile');
      const capped = freshIp();
      const bucket = await hmac(SECRET, 'tap-ip', `${capped}|${today()}`);
      const now = Date.now();
      sql(`INSERT INTO rate_events (bucket, at) VALUES ${Array.from({ length: 300 }, (_, i) => `('${bucket}', ${now - 1000 - i})`).join(', ')}`);
      assert(await tap(OPEN, { m: h, lloji: 'whatsapp' }, { ip: capped }) === 200, 'capped: not counted, but the receipt still comes');
      assert((await request(`${OPEN}/api/numero`)).status === 405, 'GET');
      // Another mjeshtër looking is a client like any other.
      assert(await tap(OPEN, { m: h, lloji: 'shikim' }, { cookie: besa }) === 204, 'another mjeshtër');
      const rows = sql('SELECT pro_id, day, views, calls, whatsapp, viber FROM pro_stats_daily');
      assert(rows.length === 1 && rows[0].pro_id === dritaId && rows[0].day === today(), JSON.stringify(rows));
      const r = rows[0];
      assert(r.views === 3 && r.calls === 1 && r.whatsapp === 1 && r.viber === 1, JSON.stringify(r));
    });
    await check('78. a tap sent from another site or from http:// is never counted (handler called directly)', async () => {
      // wrangler dev rewrites Origin, so this calls the handler as the live Worker would see the request.
      const { getPlatformProxy } = await import('wrangler');
      const { numero } = await import('../functions/drejtoria.js');
      const proxy = await getPlatformProxy({ persist: false });
      try {
        const db = proxy.env.DB;
        await applyMigrations(db);
        await db.prepare(`INSERT INTO pros (id, phone, name, trades, towns, status, created_at, updated_at, approved_at, handle)
          VALUES ('live-d', '+38344900121', 'Dren Live', '["bojaxhi"]', '["viti"]', 'approved', 1, 1, 1, 'livehandle')`).run();
        const live = { DB: db, SITE_URL: 'https://rregullo.net', APP_SECRET: SECRET, DIRECTORY_OPEN: '1' };
        const call = (env, origin) => numero.onRequestPost({
          env, waitUntil() {},
          request: new Request('https://rregullo.net/api/numero', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': freshIp(), Origin: origin }, body: JSON.stringify({ m: 'livehandle', lloji: 'thirrje' }),
          }),
        });
        const calls = async () => ((await db.prepare("SELECT calls FROM pro_stats_daily WHERE pro_id = 'live-d'").first()) || { calls: 0 }).calls;
        for (const origin of ['https://evil.example', 'http://rregullo.net', 'https://rregullo.net.evil.example', 'null']) {
          const r = await call(live, origin);
          assert(r.status === 204 && r.headers.get('Cache-Control') === 'no-store', `${origin} → ${r.status}`);
        }
        assert((await call({ ...live, DIRECTORY_OPEN: '0' }, 'https://rregullo.net')).status === 204, 'closed');
        assert((await call({ ...live, DIRECTORY_OPEN: 'yes' }, 'https://rregullo.net')).status === 204, 'not "1"');
        assert(await calls() === 0, 'counted');
        const ok = await call(live, 'https://rregullo.net');
        assert(ok.status === 200 && /^livehandle\./.test((await ok.json()).receipt) && await calls() === 1, 'this site: not counted, or no receipt');
      } finally {
        await proxy.dispose();
      }
    });

    console.log('Public directory: sitemap, Thirrjet e mia, the homepage');
    await check('79. the sitemap lists /kerko and every approved profile only once the directory is open', async () => {
      const closed = await (await request(`${BASE}/sitemap.xml`)).text();
      assert(closed.includes(`<loc>${BASE}/</loc>`) && !closed.includes('/kerko') && !closed.includes('/m/'), closed);
      const res = await request(`${OPEN}/sitemap.xml`);
      const xml = await res.text();
      assert(res.status === 200 && /xml/.test(res.headers.get('Content-Type') || '') && xml.trimEnd().endsWith('</urlset>'), `status ${res.status}`);
      assert(xml.includes(`<loc>${BASE}/</loc>`) && xml.includes(`<loc>${OPEN}/kerko</loc>`), 'static entries or /kerko');
      assert(xml.includes(`<loc>${OPEN}${dritaPath}</loc><lastmod>${today()}</lastmod>`) && xml.includes(`<loc>${OPEN}/m/rend-agron-${H('a')}</loc>`), 'approved profiles');
      for (const k of ['c', 'f', 'g', 'h', 'i']) assert(!xml.includes(H(k)), `${k} listed`);
      const approved = sql("SELECT COUNT(*) AS n FROM pros WHERE status = 'approved' AND handle IS NOT NULL")[0].n;
      assert((xml.match(/\/m\//g) || []).length === approved, `${(xml.match(/\/m\//g) || []).length} profiles of ${approved}`);
    });
    await check('80. /thirrjet serves "Thirrjet e mia", never indexed', async () => {
      const res = await request(`${BASE}/thirrjet`);
      const html = await res.text();
      assert(res.status === 200 && html.includes('id="calls-title"') && html.includes('Thirrjet e mia') && !/\{\{\w+\}\}|<!-- @/.test(html), `status ${res.status}`);
      assert(/noindex/.test(res.headers.get('X-Robots-Tag') || '') && html.includes(NOINDEX), `X-Robots-Tag: ${res.headers.get('X-Robots-Tag')}`);
      const assets = [...html.matchAll(/(?:src|href)="(\/kerko\/[^"?]+)\?v=[0-9a-f]+"/g)].map((m) => m[1]);
      assert(assets.includes('/kerko/kerko.js') && assets.includes('/kerko/kerko.css'), assets.join());
      for (const a of assets) assert((await request(`${BASE}${a}`)).status === 200, `${a} not served`);
      assert((await (await request(`${BASE}/robots.txt`)).text()).includes('Disallow: /thirrjet'), 'robots.txt');
    });
    // ---------- step 5: reviews ----------
    const REVIEW_SUBJECT = 'Konfirmo vlerësimin tënd në Rregullo';
    const HOUR = 3600000;
    const ago = (h) => Date.now() - h * HOUR;
    let nonceN = 0;
    // A receipt as the Worker signs them, for any moment: the tests can't wait 12 hours.
    const receiptAt = async (handle, at) => {
      const nonce = `n${String(nonceN++).padStart(15, '0')}`;
      return `${handle}.${at.toString(36)}.${nonce}.${(await hmac(SECRET, 'receipt', `${handle}.${at}.${nonce}`)).slice(0, 32)}`;
    };
    const sendReview = async (body, { ip = freshIp(), base = OPEN } = {}) => {
      const res = await request(`${base}/api/vleresim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'CF-Connecting-IP': ip }, body: JSON.stringify(body),
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    const reviewMails = (to) => mock.messages.filter((m) => m.subject === REVIEW_SUBJECT && m.to.includes(to));
    const reviewToken = (m) => ((m && m.text.match(/\/vleresimi\?t=([A-Za-z0-9_-]{43})/)) || [])[1];
    const linkPost = async (t, veprimi) => {
      const res = await request(`${OPEN}/vleresimi`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': freshIp() }, body: new URLSearchParams({ t, veprimi }).toString(),
      });
      return { status: res.status, html: await res.text() };
    };
    const reviewsOf = (id) => sql(`SELECT id, stars, comment, author, email, status, reply, reported_at FROM reviews WHERE pro_id = '${id}' ORDER BY created_at`);
    const visibleOf = (id) => reviewsOf(id).filter((r) => r.status === 'visible');
    async function eventually(test, what) {
      for (let i = 0; i < 40; i++) { if (test()) return; await new Promise((r) => setTimeout(r, 100)); }
      throw new Error(what);
    }
    // Writes and confirms one review; returns its link token.
    async function reviewed(handle, email, stars, extra = {}) {
      const r = await sendReview({ receipt: await receiptAt(handle, ago(13)), stars, email, ...extra });
      assert(r.status === 200, `send → ${r.status} ${JSON.stringify(r.data)}`);
      const t = reviewToken(reviewMails(email).at(-1));
      const c = await linkPost(t, 'konfirmo');
      assert(c.status === 200, `confirm → ${c.status}`);
      return t;
    }

    console.log('Reviews: the receipt and the form');
    await check('81. a tap on an approved profile gives a signed receipt; a review with it is refused before 12 hours', async () => {
      const res = await request(`${OPEN}/api/numero`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: OPEN, 'CF-Connecting-IP': freshIp() }, body: JSON.stringify({ m: dritaHandle, lloji: 'viber' }),
      });
      const { receipt } = await res.json();
      const m = /^([a-z0-9]+)\.([0-9a-z]+)\.([A-Za-z0-9_-]{16})\.([0-9a-f]{32})$/.exec(receipt || '');
      assert(res.status === 200 && m && m[1] === dritaHandle && Math.abs(parseInt(m[2], 36) - Date.now()) < 60000, `${res.status} ${receipt}`);
      assert(m[4] === (await hmac(SECRET, 'receipt', `${m[1]}.${parseInt(m[2], 36)}.${m[3]}`)).slice(0, 32), 'signature');
      const early = await sendReview({ receipt, stars: 5, email: 'klienti1@rregullo.test' });
      assert(early.status === 400 && early.data.reason === 'early' && early.data.message.includes('12 orë'), `${early.status} ${JSON.stringify(early.data)}`);
      assert(reviewsOf(dritaId).length === 0 && reviewMails('klienti1@rregullo.test').length === 0, 'stored or emailed');
    });
    await check('82. forged, altered, too old or future receipts, unlisted profiles and a closed directory: refused, nothing stored or sent', async () => {
      const good = await receiptAt(dritaHandle, ago(13));
      const [h, at, n, sig] = good.split('.');
      const flip = sig.slice(0, -1) + (sig.at(-1) === '0' ? '1' : '0');
      const before = mock.messages.length;
      for (const [receipt, reason] of [
        [`${h}.${at}.${n}.${flip}`, 'invalid'],
        [`${H('k')}.${at}.${n}.${sig}`, 'invalid'],
        [`${h}.${(Date.now() - 14 * HOUR).toString(36)}.${n}.${sig}`, 'invalid'],
        ['', 'invalid'], [42, 'invalid'], ['a.b.c.d', 'invalid'],
        [await receiptAt(dritaHandle, ago(61 * 24)), 'late'],
        [await receiptAt(dritaHandle, Date.now() + HOUR), 'invalid'],
        [await receiptAt(dritaHandle, ago(11.9)), 'early'],
      ]) {
        const r = await sendReview({ receipt, stars: 4, email: 'klienti2@rregullo.test' });
        assert(r.status === 400 && r.data.reason === reason, `${String(receipt).slice(0, 30)} → ${r.status} ${r.data.reason}`);
      }
      for (const k of ['f', 'c']) {   // pending, suspended
        const r = await sendReview({ receipt: await receiptAt(H(k), ago(13)), stars: 4, email: 'klienti2@rregullo.test' });
        assert(r.status === 404 && r.data.reason === 'gone', `${k} → ${r.status}`);
      }
      const closed = await sendReview({ receipt: good, stars: 4, email: 'klienti2@rregullo.test' }, { base: BASE });
      assert(closed.status === 404, `closed → ${closed.status}`);
      assert(sql('SELECT COUNT(*) AS n FROM reviews')[0].n === 0 && mock.messages.length === before, 'stored or emailed');
    });
    await check('83. the form is checked: stars, email, comment and name lengths; a filled honeypot is quietly dropped', async () => {
      const receipt = await receiptAt(dritaHandle, ago(13));
      for (const [body, field] of [
        [{ stars: 0 }, 'stars'], [{ stars: 6 }, 'stars'], [{ stars: 2.5 }, 'stars'], [{ stars: 'pesë' }, 'stars'],
        [{ email: '' }, 'email'], [{ email: 'jo-email' }, 'email'],
        [{ comment: 'x'.repeat(601) }, 'comment'], [{ author: 'x'.repeat(41) }, 'author'],
      ]) {
        const r = await sendReview({ receipt, stars: 5, email: 'klienti3@rregullo.test', ...body });
        assert(r.status === 400 && r.data.field === field, `${JSON.stringify(body).slice(0, 40)} → ${r.status} ${r.data.field}`);
      }
      const before = mock.messages.length;
      const bot = await sendReview({ receipt, stars: 1, email: 'klienti3@rregullo.test', company_site: 'https://spam.example' });
      assert(bot.status === 200 && bot.data.ok, `honeypot → ${bot.status}`);
      assert(sql('SELECT COUNT(*) AS n FROM reviews')[0].n === 0 && mock.messages.length === before, 'the bot review was stored or emailed');
      const text = await request(`${OPEN}/api/vleresim`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: OPEN }, body: JSON.stringify({ receipt, stars: 5, email: 'klienti3@rregullo.test' }),
      });
      assert(text.status >= 400 && text.status < 500, `text/plain → ${text.status}`);
      assert((await request(`${OPEN}/api/vleresim`)).status === 405, 'GET');
    });

    console.log('Reviews: the emailed link');
    let firstToken = '';
    await check('84. a review is stored unconfirmed and emailed; the link page publishes it only on the button, then keeps no email', async () => {
      const email = 'klienti4@rregullo.test';
      const r = await sendReview({ receipt: await receiptAt(dritaHandle, ago(13)), stars: 4, email, comment: 'Erdhi në kohë.\n<b>Punë e mirë</b>', author: 'Arta' });
      assert(r.status === 200 && r.data.ok, `${r.status} ${JSON.stringify(r.data)}`);
      const mails = reviewMails(email);
      assert(mails.length === 1 && mails[0].html.includes('Publiko vlerësimin'), `${mails.length} emails`);
      firstToken = reviewToken(mails[0]);
      assert(firstToken, 'no link');
      let [row] = reviewsOf(dritaId);
      assert(row && row.status === 'unconfirmed' && row.email === email && row.stars === 4 && row.author === 'Arta', JSON.stringify(row));
      assert(!JSON.stringify(sql('SELECT * FROM reviews')).includes(firstToken), 'the raw token is stored');
      assert(!(await get(`${OPEN}${dritaPath}`)).html.includes('Erdhi në kohë'), 'shown before confirmation');
      // Opening the link (or a scanner fetching it) publishes nothing.
      const page = await get(`${OPEN}/vleresimi?t=${firstToken}`);
      assert(page.status === 200 && page.html.includes('data-autosubmit') && page.html.includes('name="veprimi" value="konfirmo"'), `GET → ${page.status}`);
      assert(reviewsOf(dritaId)[0].status === 'unconfirmed', 'published by a GET');
      const c = await linkPost(firstToken, 'konfirmo');
      assert(c.status === 200 && c.html.includes('Vlerësimi u publikua.') && c.html.includes(`href="${dritaPath}"`), `confirm → ${c.status}`);
      [row] = reviewsOf(dritaId);
      assert(row.status === 'visible' && row.email === null, JSON.stringify(row));
      const again = await get(`${OPEN}/vleresimi?t=${firstToken}`);
      assert(again.status === 200 && again.html.includes('Vlerësimi yt është publikuar.') && again.html.includes('value="fshi"') && again.html.includes(`href="${dritaPath}"`), `again → ${again.status}`);
      assert((await linkPost('x'.repeat(43), 'konfirmo')).status === 400, 'unknown token');
      assert((await linkPost(firstToken, 'publiko')).status === 400, 'unknown action');
      assert((await get(`${OPEN}/vleresimi?t=short`)).status === 400, 'short token');
    });
    await check('85. a confirmed review shows on the profile, escaped, with the stars in search and in the share data', async () => {
      const p = await get(`${OPEN}${dritaPath}`);
      assert(p.html.includes('Erdhi në kohë.') && p.html.includes('&lt;b&gt;Punë e mirë&lt;/b&gt;') && !p.html.includes('<b>Punë'), 'comment');
      assert(p.html.includes('★★★★☆') && p.html.includes('Arta · ') && p.html.includes('4,0 nga 5 · 1 vlerësim'), 'stars, name or summary');
      const ld = JSON.parse(p.html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
      assert(ld.aggregateRating && ld.aggregateRating.ratingValue === 4 && ld.aggregateRating.reviewCount === 1, JSON.stringify(ld.aggregateRating));
      const s = await get(`${OPEN}/kerko?zanati=elektricist&komuna=gjilan`);
      assert(s.html.includes('4,0') && s.html.includes('1 vlerësim'), 'stars on the card');
      const none = await get(`${OPEN}/m/rend-bekim-${H('b')}`);
      assert(none.html.includes('Ende pa vlerësime.') && !none.html.includes('aggregateRating'), 'a profile without reviews');
    });
    await check('86. one receipt gives one review; the same email again replaces its review; the link deletes it', async () => {
      const receipt = await receiptAt(dritaHandle, ago(20));
      const a = await sendReview({ receipt, stars: 2, email: 'klienti5@rregullo.test' });
      const b = await sendReview({ receipt, stars: 5, email: 'klienti6@rregullo.test' });
      assert(a.status === 200 && b.status === 200, `${a.status} ${b.status}`);
      assert((await linkPost(reviewToken(reviewMails('klienti5@rregullo.test').at(-1)), 'konfirmo')).status === 200, 'confirm the first');
      const second = await linkPost(reviewToken(reviewMails('klienti6@rregullo.test').at(-1)), 'konfirmo');
      assert(second.status === 409 && second.html.includes('Për këtë thirrje është dhënë tashmë një vlerësim.'), `the second review of one receipt → ${second.status}`);
      const used = await sendReview({ receipt, stars: 5, email: 'klienti6@rregullo.test' });
      assert(used.status === 409 && used.data.reason === 'used', `${used.status} ${used.data.reason}`);
      assert(visibleOf(dritaId).length === 2, JSON.stringify(visibleOf(dritaId)));
      // Arta reviews again after another call: it replaces her 4 stars.
      const t = await reviewed(dritaHandle, 'klienti4@rregullo.test', 5, { comment: 'Sërish shumë mirë.' });
      const visible = visibleOf(dritaId);
      assert(visible.length === 2 && visible.some((r) => r.stars === 5 && r.comment === 'Sërish shumë mirë.') && !visible.some((r) => r.comment.startsWith('Erdhi')), JSON.stringify(visible));
      assert((await linkPost(firstToken, 'fshi')).status === 400, 'the replaced review\'s link still works');
      const del = await linkPost(t, 'fshi');
      assert(del.status === 200 && del.html.includes('Vlerësimi yt u fshi.'), `delete → ${del.status}`);
      assert(visibleOf(dritaId).map((r) => r.stars).join() === '2', JSON.stringify(visibleOf(dritaId)));
      assert((await linkPost(t, 'fshi')).status === 400, 'deleted twice');
    });
    await check('87. an unconfirmed review expires after 48 hours and is cleared away with its email', async () => {
      const r = await sendReview({ receipt: await receiptAt(dritaHandle, ago(30)), stars: 3, email: 'klienti8@rregullo.test' });
      assert(r.status === 200, `send → ${r.status}`);
      const t = reviewToken(reviewMails('klienti8@rregullo.test').at(-1));
      sql(`UPDATE reviews SET created_at = created_at - ${49 * HOUR} WHERE email = 'klienti8@rregullo.test'`);
      const c = await linkPost(t, 'konfirmo');
      assert(c.status === 410 && c.html.includes('Kjo lidhje ka skaduar.'), `→ ${c.status}`);
      // Any review sent afterwards clears it.
      await sendReview({ receipt: await receiptAt(dritaHandle, ago(31)), stars: 3, email: 'klienti9@rregullo.test' });
      await eventually(() => sql("SELECT COUNT(*) AS n FROM reviews WHERE email = 'klienti8@rregullo.test'")[0].n === 0, 'not cleared');
    });
    await check('88. at most 5 reviews an hour from one network address, and 5 links a day to one email', async () => {
      const ip = freshIp();
      for (let i = 0; i < 5; i++) {
        const r = await sendReview({ receipt: await receiptAt(dritaHandle, ago(14)), stars: 3, email: `kufiri${i}@rregullo.test` }, { ip });
        assert(r.status === 200, `#${i + 1} → ${r.status}`);
      }
      const sixth = await sendReview({ receipt: await receiptAt(dritaHandle, ago(14)), stars: 3, email: 'kufiri9@rregullo.test' }, { ip });
      assert(sixth.status === 429 && sixth.data.reason === 'rate_limited', `${sixth.status} ${sixth.data.reason}`);
      for (let i = 0; i < 5; i++) assert((await sendReview({ receipt: await receiptAt(dritaHandle, ago(14)), stars: 3, email: 'shume@rregullo.test' })).status === 200, `email #${i + 1}`);
      const more = await sendReview({ receipt: await receiptAt(dritaHandle, ago(14)), stars: 3, email: 'shume@rregullo.test' });
      assert(more.status === 429, `email #6 → ${more.status}`);
      assert(reviewMails('shume@rregullo.test').length === 5 && reviewMails('kufiri9@rregullo.test').length === 0, 'emails');
      sql("DELETE FROM reviews WHERE status = 'unconfirmed'");
    });

    console.log('Reviews: the mjeshtër and the team');
    let reviewId = '';
    await check('89. the mjeshtër sees the reviews on Ballina, replies once in public, and reports one to the team', async () => {
      await reviewed(dritaHandle, 'klienti7@rregullo.test', 1, { comment: 'Nuk erdhi fare.', author: 'Besnik' });
      const d = (await me(drita)).data.dashboard;
      assert(d.reviews.length === 2 && d.stats.rating === 1.5 && d.stats.reviews === 2 && d.stats.newReviews === 2, JSON.stringify(d.stats));
      const r = d.reviews.find((x) => x.comment === 'Nuk erdhi fare.');
      reviewId = r.id;
      assert(r.author === 'Besnik' && !r.reported && !r.reply && !('email' in r) && !('emailHash' in r), JSON.stringify(r));
      const other = d.reviews.find((x) => x.id !== reviewId).id;
      assert((await api('/api/mjeshtri/pergjigju', { id: reviewId, text: '  ' }, { cookie: drita })).status === 400, 'empty reply');
      assert((await api('/api/mjeshtri/pergjigju', { id: reviewId, text: 'x'.repeat(401) }, { cookie: drita })).status === 400, 'long reply');
      const rep = await api('/api/mjeshtri/pergjigju', { id: reviewId, text: 'Më vjen keq, pata një urgjencë. <i>Ju thirra</i>.' }, { cookie: drita });
      assert(rep.status === 200 && rep.data.dashboard.reviews.find((x) => x.id === reviewId).reply.startsWith('Më vjen keq'), `${rep.status} ${JSON.stringify(rep.data).slice(0, 200)}`);
      assert((await api('/api/mjeshtri/pergjigju', { id: reviewId, text: 'Prapë.' }, { cookie: drita })).status === 409, 'a second reply');
      // Another mjeshtër can't touch it.
      for (const [path, body] of [['pergjigju', { id: other, text: 'Hi' }], ['raporto', { id: reviewId, reason: 'Nuk më pëlqen.' }]]) {
        const x = await api(`/api/mjeshtri/${path}`, body, { cookie: besa });
        assert(x.status === 404 || x.status === 403, `another mjeshtër: ${path} → ${x.status}`);
      }
      assert(!reviewsOf(dritaId).find((x) => x.id === other).reply && !reviewsOf(dritaId).find((x) => x.id === reviewId).reported_at, 'changed by another mjeshtër');
      const p = await get(`${OPEN}${dritaPath}`);
      assert(p.html.includes('Përgjigja e Drit') && p.html.includes('&lt;i&gt;Ju thirra&lt;/i&gt;'), 'the reply on the profile');
      assert((await api('/api/mjeshtri/raporto', { id: reviewId, reason: '' }, { cookie: drita })).status === 400, 'no reason');
      sql(`DELETE FROM rate_events WHERE bucket = '${await hmac(SECRET, 'admin-queue', String(Math.floor(Date.now() / 3600000)))}'`);
      const before = mock.messages.length;
      const rp = await api('/api/mjeshtri/raporto', { id: reviewId, reason: 'Ky klient nuk më ka thirrur kurrë.' }, { cookie: drita });
      assert(rp.status === 200 && rp.data.dashboard.reviews.find((x) => x.id === reviewId).reported, `${rp.status} ${JSON.stringify(rp.data).slice(0, 200)}`);
      assert((await api('/api/mjeshtri/raporto', { id: reviewId, reason: 'Prapë.' }, { cookie: drita })).status === 409, 'reported twice');
      await eventually(() => mock.messages.slice(before).some((m) => m.text.includes('1 vlerësim i raportuar')), 'no queue email for the report');
      assert((await get(`${OPEN}${dritaPath}`)).html.includes('Nuk erdhi fare.'), 'hidden by the report alone');
    });
    await check('90. the team sees reported reviews in their own list, keeps or hides them, and can show one again; each goes into the history', async () => {
      const list = await team('mjeshtrit', { status: 'reported' }, { cookie: ekipi1 });
      assert(list.status === 200 && list.data.counts.reported === 1 && list.data.items.map((i) => i.id).join() === dritaId, JSON.stringify(list.data.counts));
      const p = await detail(dritaId);
      const r = p.reviews.find((x) => x.id === reviewId);
      assert(r.reported && r.reportReason === 'Ky klient nuk më ka thirrur kurrë.', JSON.stringify(r));
      for (const [body, status] of [[{ action: 'delete' }, 400], [{ reviewId: '00000000-0000-0000-0000-000000000000' }, 404], [{ id: 'test-d-k' }, 404], [{ id: 'nobody' }, 404]]) {
        const x = await team('vleresim', { id: dritaId, reviewId, action: 'hide', ...body }, { cookie: ekipi1 });
        assert(x.status === status, `${JSON.stringify(body)} → ${x.status}`);
      }
      assert((await api('/api/admin/vleresim', { id: dritaId, reviewId, action: 'hide' }, { cookie: drita })).status === 401, 'the mjeshtër moderated');
      const keep = await team('vleresim', { id: dritaId, reviewId, action: 'keep' }, { cookie: ekipi1 });
      assert(keep.status === 200 && !keep.data.pro.reviews.find((x) => x.id === reviewId).reported, `keep → ${keep.status}`);
      assert((await team('vleresim', { id: dritaId, reviewId, action: 'keep' }, { cookie: ekipi1 })).status === 409, 'kept twice');
      assert((await team('mjeshtrit', { status: 'reported' }, { cookie: ekipi1 })).data.counts.reported === 0, 'still listed');
      const hide = await team('vleresim', { id: dritaId, reviewId, action: 'hide', note: 'Klienti nuk e ka thirrur.' }, { cookie: ekipi2 });
      assert(hide.status === 200 && hide.data.pro.reviews.find((x) => x.id === reviewId).hidden, `hide → ${hide.status}`);
      const page = await get(`${OPEN}${dritaPath}`);
      assert(!page.html.includes('Nuk erdhi fare.') && page.html.includes('2,0 nga 5 · 1 vlerësim'), 'a hidden review is shown or counted');
      assert((await me(drita)).data.dashboard.reviews.find((x) => x.id === reviewId).hidden, 'the mjeshtër doesn\'t see it hidden');
      const show = await team('vleresim', { id: dritaId, reviewId, action: 'show' }, { cookie: ekipi1 });
      assert(show.status === 200 && (await get(`${OPEN}${dritaPath}`)).html.includes('Nuk erdhi fare.'), 'not shown again');
      const log = show.data.pro.log;
      assert(log.slice(0, 3).map((l) => l.action).join() === 'review_show,review_hide,review_keep', log.map((l) => l.action).join());
      assert(log[1].admin === TEAM[1] && log[1].note === 'Klienti nuk e ka thirrur.', JSON.stringify(log[1]));
    });
    await check('91. reviews rank a mjeshtër: good stars from a few reviews go ahead, a bad one falls behind', async () => {
      const t = Date.now() - 86400000;
      const row = (pro, stars, i) => `('rv-${pro}-${i}', '${pro}', 'seed-${pro}-${i}', ${t}, ${stars}, 'h-${pro}-${i}', 't-${pro}-${i}', 'visible', ${t}, ${t})`;
      sql(`INSERT INTO reviews (id, pro_id, receipt, tapped_at, stars, email_hash, token_hash, status, created_at, confirmed_at) VALUES
        ${[5, 5, 4].map((s, i) => row('test-d-b', s, i)).join(', ')}, ${row('test-d-k', 1, 0)}`);
      const r = await get(`${OPEN}/kerko?zanati=bojaxhi&komuna=viti`);
      // Bekim (4,7 from 3, a less complete profile) passes Kujtim (1 star, Verifikuar); Agron stays last, as he isn't taking work.
      assert(cardsOf(r.html).join() === ['b', 'k', 'a'].map(H).join(), cardsOf(r.html).join());
      assert(r.html.includes('4,7') && r.html.includes('3 vlerësime'), 'Bekim\'s stars');
    });


    // ---------- step 6: ads ----------
    const adsApi = (path, body, c = ekipi1) => team(path, body, { cookie: c });
    const plus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const adsIn = (html) => [...html.matchAll(/<aside class="ad" data-ad="([^"]+)" data-ad-vendi="([^"]+)"/g)].map((m) => `${m[1]}|${m[2]}`);
    const adUpload = (id, bytes, c = ekipi1) => request(`${BASE}/api/admin/fushata/foto?id=${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'Content-Type': 'image/jpeg', Origin: BASE, Cookie: c }, body: bytes,
    }).then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }));
    let advId = '';
    let campId = '';
    let campB = '';
    const CAMP = () => ({ advertiserId: advId, title: 'Bojë fasade -20% këtë muaj', link: 'https://bojera.example/oferta?x=1', slots: ['kerko', 'profili', 'loja', 'paneli'], trades: ['elektricist'], towns: ['gjilan'], startsOn: today(), endsOn: plus(30) });

    console.log('Ads');
    await check('92. the team adds an advertiser and campaigns; bad input is refused, and only the team gets in', async () => {
      assert((await api('/api/admin/reklamat', {}, { cookie: drita })).status === 401, 'a mjeshtër');
      assert((await api('/api/admin/reklamat', {})).status === 401, 'nobody');
      const bad = await adsApi('reklamuesi', { name: ' ' });
      assert(bad.status === 400 && bad.data.errors.name, JSON.stringify(bad.data));
      const a = await adsApi('reklamuesi', { name: 'Bojëra & Co <b>', contact: 'Agim, 044 999 888' });
      assert(a.status === 200 && a.data.advertisers.length === 1 && a.data.advertisers[0].contact === 'Agim, 044 999 888', JSON.stringify(a.data).slice(0, 200));
      advId = a.data.id;
      for (const [body, field] of [[{ title: '' }, 'title'], [{ title: 'x'.repeat(91) }, 'title'], [{ link: 'http://bojera.example' }, 'link'], [{ link: 'javascript:alert(1)' }, 'link'],
        [{ link: 'https://user:pw@bojera.example' }, 'link'], [{ slots: [] }, 'slots'], [{ slots: ['ballina'] }, 'slots'], [{ endsOn: plus(-1) }, 'dates'], [{ startsOn: '2026-02-30' }, 'dates']]) {
        const r = await adsApi('fushata', { ...CAMP(), ...body });
        assert(r.status === 400 && r.data.errors[field], `${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.data.errors)}`);
      }
      assert((await adsApi('fushata', { ...CAMP(), advertiserId: '00000000-0000-0000-0000-000000000000' })).status === 404, 'unknown advertiser');
      const c = await adsApi('fushata', { ...CAMP(), trades: ['elektricist', 'nope'], towns: ['gjilan', 'gjilan'] });
      assert(c.status === 200 && c.data.campaign.state === 'live' && c.data.campaign.trades.join() === 'elektricist' && c.data.campaign.towns.join() === 'gjilan', JSON.stringify(c.data.campaign));
      campId = c.data.campaign.id;
      // A second one, for every trade and town but only in the games, starting tomorrow.
      const later = await adsApi('fushata', { ...CAMP(), title: 'Vegla elektrike', trades: [], towns: [], slots: ['loja'], startsOn: plus(1), endsOn: plus(10) });
      assert(later.status === 200 && later.data.campaign.state === 'scheduled', JSON.stringify(later.data.campaign));
      campB = later.data.campaign.id;
      assert(later.data.advertisers[0].campaigns.length === 2, 'the list');
    });
    await check('93. a campaign shows only on its trades and towns and between its dates, marked Sponsorizuar and escaped', async () => {
      const s = await get(`${OPEN}/kerko?zanati=elektricist&komuna=gjilan`);
      assert(adsIn(s.html).join() === `${campId}|kerko`, adsIn(s.html).join());
      assert(s.html.includes('Sponsorizuar · Bojëra &amp; Co &lt;b&gt;') && s.html.includes(`href="/r/${campId}?v=kerko"`) && s.html.includes('rel="sponsored noopener"'), 'label or link');
      assert(s.html.includes('<li class="dir-ad-item">') && !s.html.includes('044 999 888'), 'in the list, without the contact');
      for (const q of ['?zanati=elektricist&komuna=kamenice', '?zanati=bojaxhi&komuna=viti', '?komuna=gjilan', '?zanati=elektricist', '?zanati=kulmi&komuna=junik']) {
        assert(adsIn((await get(`${OPEN}/kerko${q}`)).html).length === 0, `${q} has an ad`);
      }
      assert(adsIn((await get(`${OPEN}${dritaPath}`)).html).join() === `${campId}|profili`, 'profile');
      assert(adsIn((await get(`${OPEN}/m/rend-bekim-${H('b')}`)).html).length === 0, 'a bojaxhi profile');
      // Pages drawn in the browser ask for theirs: the games have no trade, so only an untargeted ad fits, and that one starts tomorrow.
      assert((await request(`${OPEN}/api/reklama?vendi=loja`)).status === 204, 'games');
      const panel = await request(`${OPEN}/api/reklama?vendi=paneli&zanati=elektricist,murator&komuna=gjilan`);
      const pd = await panel.json();
      assert(panel.status === 200 && pd.ad.id === campId && pd.ad.href === `/r/${campId}?v=paneli` && pd.ad.advertiser === 'Bojëra & Co <b>' && pd.ad.image === null, JSON.stringify(pd));
      assert((await request(`${OPEN}/api/reklama?vendi=paneli&zanati=murator&komuna=gjilan`)).status === 204, 'another trade');
      assert((await request(`${OPEN}/api/reklama?vendi=kerko`)).status === 204, 'kerko from the API');
      sql(`UPDATE campaigns SET starts_on = '${today()}' WHERE id = '${campB}'`);
      const g = await (await request(`${OPEN}/api/reklama?vendi=loja`)).json();
      assert(g.ad.id === campB && g.ad.title === 'Vegla elektrike', JSON.stringify(g));
      sql(`UPDATE campaigns SET ends_on = '${plus(-1)}', starts_on = '${plus(-5)}' WHERE id = '${campB}'`);
      assert((await request(`${OPEN}/api/reklama?vendi=loja`)).status === 204, 'an ended campaign');
      const html = await (await request(`${BASE}/loja/`)).text();
      assert(html.includes('data-ad-slot="loja"') && html.includes('src="/reklama.js"'), 'the games page has no slot');
    });
    await check('94. views and clicks are counted once per person per day, never for the team, and a click goes on to the advertiser', async () => {
      const view = (body, { ip = freshIp(), cookie: c = '' } = {}) => request(`${OPEN}/api/reklama`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: OPEN, 'CF-Connecting-IP': ip, ...(c ? { Cookie: c } : {}) }, body: JSON.stringify(body),
      }).then((r) => r.status);
      const click = (path, { ip = freshIp(), cookie: c = '' } = {}) => request(`${OPEN}${path}`, { redirect: 'manual', headers: { 'CF-Connecting-IP': ip, ...(c ? { Cookie: c } : {}) } });
      const [ip1, ip2] = [freshIp(), freshIp()];
      for (const [b, ip] of [[{ id: campId, vendi: 'kerko' }, ip1], [{ id: campId, vendi: 'kerko' }, ip1], [{ id: campId, vendi: 'kerko' }, ip2], [{ id: campId, vendi: 'profili' }, ip1]]) {
        assert(await view(b, { ip }) === 204, 'view');
      }
      for (const b of [{ id: campId, vendi: 'ballina' }, { id: 'nope', vendi: 'kerko' }, { id: campId }, { id: campB, vendi: 'loja' }]) assert(await view(b) === 204, `bad ${JSON.stringify(b)}`);
      assert(await view({ id: campId, vendi: 'kerko' }, { cookie: ekipi1 }) === 204, 'team');
      const r1 = await click(`/r/${campId}?v=kerko`, { ip: ip1 });
      assert(r1.status === 302 && r1.headers.get('Location') === 'https://bojera.example/oferta?x=1' && r1.headers.get('Cache-Control') === 'no-store', `${r1.status} ${r1.headers.get('Location')}`);
      await click(`/r/${campId}?v=kerko`, { ip: ip1 });
      await click(`/r/${campId}?v=kerko`, { cookie: ekipi1 });
      await click(`/r/${campId}?v=zzz`);
      await click(`/r/${campId}`);
      const unknown = await click('/r/00000000-0000-0000-0000-000000000000?v=kerko');
      assert(unknown.status === 302 && unknown.headers.get('Location') === '/', `unknown → ${unknown.status} ${unknown.headers.get('Location')}`);
      const rows = sql(`SELECT slot, views, clicks FROM ad_stats_daily WHERE campaign_id = '${campId}' ORDER BY slot`);
      assert(JSON.stringify(rows) === JSON.stringify([{ slot: 'kerko', views: 2, clicks: 1 }, { slot: 'profili', views: 1, clicks: 0 }]), JSON.stringify(rows));
      assert(sql(`SELECT COUNT(*) AS n FROM ad_stats_daily WHERE campaign_id = '${campB}'`)[0].n === 0, 'an ended campaign counted');
      const c = (await adsApi('reklamat', {})).data.advertisers[0].campaigns.find((x) => x.id === campId);
      assert(c.views30 === 3 && c.clicks30 === 1, JSON.stringify(c));
    });
    await check('95. the monthly report per advertiser matches the counts, as a CSV download for the team only', async () => {
      const month = today().slice(0, 7);
      const url = `/api/admin/raporti?reklamuesi=${advId}&muaji=${month}`;
      const res = await request(`${BASE}${url}`, { headers: { Cookie: ekipi1 } });
      const csv = await res.text();
      assert(res.status === 200 && /text\/csv/.test(res.headers.get('Content-Type')) && /^attachment; filename="rregullo-raporti-bojera-co-b-\d{4}-\d{2}\.csv"$/.test(res.headers.get('Content-Disposition')), `${res.status} ${res.headers.get('Content-Disposition')}`);
      const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
      assert(lines[0] === 'Reklama,Dita,Vendi,Shikime,Klikime', lines[0]);
      assert(lines.includes(`Bojë fasade -20% këtë muaj,${today()},Kërkimi,2,1`) && lines.includes(`Bojë fasade -20% këtë muaj,${today()},Profilet,1,0`), csv);
      assert(lines.includes(`Gjithsej: Bojë fasade -20% këtë muaj,${month},,3,1`), csv);
      for (const [q, status] of [[`?reklamuesi=${advId}&muaji=2026-13`, 400], [`?reklamuesi=${advId}`, 400], [`?reklamuesi=00000000-0000-0000-0000-000000000000&muaji=${month}`, 404]]) {
        assert((await request(`${BASE}/api/admin/raporti${q}`, { headers: { Cookie: ekipi1 } })).status === status, q);
      }
      assert((await request(`${BASE}${url}`, { headers: { Cookie: drita } })).status === 401, 'a mjeshtër');
      assert((await request(`${BASE}${url}`)).status === 401, 'nobody');
      // A title a spreadsheet would run as a formula is written as text.
      sql(`UPDATE campaigns SET title = '=HYPERLINK("x")' WHERE id = '${campB}'`);
      sql(`INSERT INTO ad_stats_daily (campaign_id, day, slot, views, clicks) VALUES ('${campB}', '${month}-01', 'loja', 4, 0)`);
      const csv2 = await (await request(`${BASE}${url}`, { headers: { Cookie: ekipi1 } })).text();
      assert(csv2.includes(`"'=HYPERLINK(""x"")",${month}-01,Lojërat,4,0`), csv2);
    });
    await check('96. a campaign can be changed, switched off, given an image and deleted with its counts; deleting the advertiser removes the rest', async () => {
      const off = await adsApi('fushata', { ...CAMP(), id: campId, advertiserId: undefined, title: 'Bojë fasade -25%', link: 'https://bojera.example/', active: false });
      assert(off.status === 200 && off.data.campaign.state === 'off' && off.data.campaign.title === 'Bojë fasade -25%', JSON.stringify(off.data).slice(0, 200));
      assert(adsIn((await get(`${OPEN}/kerko?zanati=elektricist&komuna=gjilan`)).html).length === 0, 'shown while off');
      const r = await request(`${OPEN}/r/${campId}?v=kerko`, { redirect: 'manual', headers: { 'CF-Connecting-IP': freshIp() } });
      assert(r.status === 302 && r.headers.get('Location') === 'https://bojera.example/', 'an old link no longer leads on');
      assert(sql(`SELECT SUM(clicks) AS n FROM ad_stats_daily WHERE campaign_id = '${campId}'`)[0].n === 1, 'a click on a switched-off ad counted');
      const on = await adsApi('fushata', { ...CAMP(), id: campId, advertiserId: undefined, active: true });
      assert(on.status === 200 && on.data.campaign.state === 'live', 'back on');
      assert((await adsApi('fushata', { ...CAMP(), id: '00000000-0000-0000-0000-000000000000' })).status === 404, 'unknown campaign');
      // The image
      assert((await adUpload(campId, Buffer.from('not a jpeg'))).status === 400, 'not a JPEG');
      const up = await adUpload(campId, JPEG);
      assert(up.status === 200 && /^\/foto\/[0-9a-f-]{36}\.jpg$/.test(up.data.campaign.image), JSON.stringify(up.data).slice(0, 200));
      const img = up.data.campaign.image;
      assert((await request(`${BASE}${img}`)).status === 200, 'the image is not served');
      const s = await get(`${OPEN}/kerko?zanati=elektricist&komuna=gjilan`);
      assert(s.html.includes(`<img class="ad-img" src="${img}" alt=""`), 'the image in the ad');
      const second = await adUpload(campId, JPEG);
      assert(second.status === 200 && second.data.campaign.image !== img && (await request(`${BASE}${img}`)).status === 404, 'the old image stays');
      const gone = await adsApi('fushata/foto/hiq', { id: campId });
      assert(gone.status === 200 && gone.data.campaign.image === null && (await request(`${BASE}${second.data.campaign.image}`)).status === 404, 'image not removed');
      // Deleting
      assert((await adsApi('fushata/fshi', { id: campB })).status === 200, 'delete a campaign');
      assert(sql(`SELECT COUNT(*) AS n FROM ad_stats_daily WHERE campaign_id = '${campB}'`)[0].n === 0, 'its counts stayed');
      assert((await adsApi('fushata/fshi', { id: campB })).status === 404, 'deleted twice');
      assert((await adsApi('reklamuesi/fshi', { id: advId, confirm: 'fshije' })).status === 400, 'without the word');
      const del = await adsApi('reklamuesi/fshi', { id: advId, confirm: 'FSHIJE' });
      assert(del.status === 200 && del.data.advertisers.length === 0, JSON.stringify(del.data).slice(0, 200));
      assert(sql('SELECT COUNT(*) AS n FROM campaigns')[0].n === 0 && sql('SELECT COUNT(*) AS n FROM ad_stats_daily')[0].n === 0, 'left behind');
    });
    await check('97. the terms of use and the privacy notice cover reviews and ads; every page links them', async () => {
      const terms = await request(`${BASE}/kushtet`);
      const html = await terms.text();
      assert(terms.status === 200 && html.includes('<h1>Kushtet e përdorimit</h1>') && html.includes('id="reklamat"') && !/\{\{\w+\}\}|<!-- @/.test(html), `status ${terms.status}`);
      const privacy = await (await request(`${BASE}/privatesia`)).text();
      assert(privacy.includes('id="vleresimet"') && privacy.includes('id="reklamat"'), 'privacy sections');
      assert((await get(`${OPEN}/kerko`)).html.includes('<a href="/kushtet">Kushtet</a>'), 'the directory footer');
      const robots = await (await request(`${BASE}/robots.txt`)).text();
      assert(robots.includes('Disallow: /r/'), 'robots.txt');
    });

    // Rebuilding dist/ under the running servers breaks their static files, so this comes last of the HTTP checks.
    await check('98. the build: DIRECTORY_OPEN=1 swaps the homepage signup for the search box; without it the signup stays', async () => {
      const index = () => readFileSync(join(root, 'dist', 'index.html'), 'utf8');
      const build = (env) => execFileSync('node', ['scripts/build.mjs'], { cwd: root, stdio: 'ignore', env });
      let open = '';
      try {
        build({ ...buildEnv, DIRECTORY_OPEN: '1' });
        open = index();
      } finally {
        build(buildEnv);   // back to what the servers serve
      }
      assert(open.includes('data-home-find') && open.includes('<form class="find" action="/kerko" method="get"'), 'no search box');
      assert(/<select[^>]* id="home-zanati" name="zanati">/.test(open) && /<select[^>]* id="home-komuna" name="komuna">/.test(open), 'trade and town');
      assert(!open.includes('data-signup') && !open.includes('action="/api/subscribe"'), 'the signup is still there');
      const closed = index();
      assert(closed.includes('data-signup') && closed.includes('action="/api/subscribe"') && !closed.includes('data-home-find'), 'the default build lost the signup');
    });


    console.log('Logs');
    await check('99. logs contain no addresses, phone numbers, tokens or codes', async () => {
      // Photo ids and pro ids are random UUIDs, and their digits can look like a number or a code by chance: leave them out.
      const scanned = (devLog.slice(logStart) + openLog.slice(openLogStart)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');
      const at = (i) => JSON.stringify(scanned.slice(Math.max(0, i - 80), i + 40));
      const email = scanned.match(/[a-z0-9.+-]+@rregullo\.test/i);
      assert(!email, `an address appears in the logs: ${email && at(email.index)}`);
      const phone = scanned.match(/\+?383\s?4\d|04\d\s?\d{3}/);
      assert(!phone, `a phone number appears in the logs: ${phone && at(phone.index)}`);
      const links = mock.messages.filter((m) => m.subject === LINK_SUBJECT);
      assert(links.length >= 10, `${links.length} link emails`);
      for (const m of links) {
        assert(!scanned.includes(tokenOf(m)), 'a link token appears in the logs');
        assert(!new RegExp(`(?<!\\d)${codeOf(m)}(?!\\d)`).test(scanned), 'a link code appears in the logs');
      }
      for (const m of mock.messages.filter((x) => x.subject === REVIEW_SUBJECT)) assert(!scanned.includes(reviewToken(m)), 'a review link token appears in the logs');
      for (const c of [ekipi1, ekipi2, ekipi3]) assert(!scanned.includes(c.split('=')[1]), 'a session token appears in the logs');
      for (const m of sms) {
        const code = (m.Body.match(/^(\d{6}) /) || [])[1];
        if (code) assert(!new RegExp(`(?<!\\d)${code}(?!\\d)`).test(scanned), 'an SMS code appears in the logs');
      }
      assert(!scanned.includes('Foli me të'), "the team's note appears in the logs");
    });
  } finally {
    dev.kill('SIGTERM');
    openDev.kill('SIGTERM');
    mock.server.close();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
