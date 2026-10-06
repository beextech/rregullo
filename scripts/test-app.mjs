// End-to-end test of the mjeshtër sign-in (step 1) and dashboard (step 2) against the real Worker, a local D1 database
// and a local R2 bucket, with scripts/mock-email.mjs standing in for Twilio (SMS) and Cloudflare Turnstile.
// Nothing is sent or stored anywhere else.
//   npm run test:app      (npm test runs it after the signup tests)

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hmac } from '../server/crypto.js';
import { startMockEmail } from './mock-email.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8792;
const MOCK_PORT = 8793;
const BASE = `http://localhost:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const SECRET = 'test-secret-0123456789abcdefghijklmnopqrstuvwxyz';
const STATE = join(root, '.wrangler', 'test-app');
const wrangler = join(root, 'node_modules', '.bin', 'wrangler');

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

let ipCounter = 1;
const freshIp = () => `203.0.113.${ipCounter++}`;

// wrangler's dev server sometimes drops a kept-alive socket after a response that scheduled background work;
// browsers retry that transparently, so the test does too (once, and only on a socket error).
async function request(url, init) {
  try { return await fetch(url, init); } catch (e) {
    if (e.cause && e.cause.code === 'UND_ERR_SOCKET') return fetch(url, init);
    throw e;
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
  execFileSync('node', ['scripts/build.mjs'], { cwd: root, stdio: 'ignore', env: { ...process.env, SITE_URL: BASE, TURNSTILE_SITE_KEY: '1x00000000000000000000AA' } });
  rmSync(STATE, { recursive: true, force: true });
  execFileSync(wrangler, ['d1', 'migrations', 'apply', 'rregullo-launch', '--local', '--persist-to', STATE], { cwd: root, stdio: 'ignore' });

  const mock = await startMockEmail(MOCK_PORT);
  const sms = mock.sms;
  const dev = spawn(wrangler, ['dev', '--port', String(PORT), '--persist-to', STATE,
    '--var', `APP_SECRET:${SECRET}`, '--var', `SITE_URL:${BASE}`,
    '--var', 'TWILIO_ACCOUNT_SID:ACtest', '--var', 'TWILIO_AUTH_TOKEN:test-token', '--var', `SMS_API_BASE:${MOCK}`,
    '--var', 'TURNSTILE_SECRET_KEY:test-turnstile', '--var', `TURNSTILE_VERIFY_URL:${MOCK}/turnstile/v0/siteverify`],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', SITE_URL: BASE, TURNSTILE_SITE_KEY: '1x00000000000000000000AA' } });
  let devLog = '';
  dev.stdout.on('data', (d) => { devLog += d; });
  dev.stderr.on('data', (d) => { devLog += d; });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
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
        for (const f of ['0001_subscribers.sql', '0002_mjeshtrit.sql', '0003_paneli.sql']) {
          const schema = readFileSync(join(root, 'migrations', f), 'utf8');
          for (const stmt of schema.replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(stmt).run();
        }
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
        for (const f of ['0001_subscribers.sql', '0002_mjeshtrit.sql', '0003_paneli.sql']) {
          const schema = readFileSync(join(root, 'migrations', f), 'utf8');
          for (const stmt of schema.replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(stmt).run();
        }
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
      assert(!/\+?383\s?4\d|04\d\s?\d{3}/.test(devLog), 'a phone number appears in the logs');
      for (const m of sms) {
        const code = (m.Body.match(/^(\d{6}) /) || [])[1];
        assert(!devLog.includes(code), 'a code appears in the logs');
      }
    });
  } finally {
    dev.kill('SIGTERM');
    mock.server.close();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
