// End-to-end test of the mjeshtër sign-in (step 1) against the real Worker and a local D1 database,
// with scripts/mock-email.mjs standing in for Twilio (SMS) and Cloudflare Turnstile. Nothing is sent anywhere.
//   npm run test:app      (npm test runs it after the signup tests)

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
      assert(html.includes('data-sitekey="1x00000000000000000000AA"') && html.includes('challenges.cloudflare.com/turnstile'), 'Turnstile widget');
      const csp = res.headers.get('Content-Security-Policy') || '';
      assert(csp.includes('https://challenges.cloudflare.com') && !csp.includes(','), `CSP: ${csp}`);
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
      assert(me.status === 200 && me.data.pro.phone === '+383 44 100 200' && me.data.pro.status === 'draft', JSON.stringify(me.data));
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
      assert((await api('/api/mjeshtri/kodi', { phone: '044 100 200', pad: 'x'.repeat(5000) })).status === 413, 'oversized');
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

    console.log('Production settings');
    await check('19. live site: no code ever sent without the SMS and bot-check secrets; the cookie is Secure', async () => {
      const { getPlatformProxy } = await import('wrangler');
      const { kodi, hyr } = await import('../functions/api/mjeshtri.js');
      const proxy = await getPlatformProxy({ persist: false });
      try {
        const db = proxy.env.DB;
        for (const f of ['0001_subscribers.sql', '0002_mjeshtrit.sql']) {
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
    await check('20. logs contain no phone numbers or codes', async () => {
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
