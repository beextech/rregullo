// End-to-end test of the signup flow against the real Functions and a local D1 database,
// with scripts/mock-email.mjs standing in for Resend. Nothing is sent to real inboxes.
//   npm test
// It builds the site, starts `wrangler dev` on port 8789 with a fresh database, runs every case,
// and stops everything again.

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockEmail } from './mock-email.mjs';
import { unsubscribeSig } from '../server/crypto.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8789;
const MAIL_PORT = 8791;
const BASE = `http://localhost:${PORT}`;
const SECRET = 'test-secret-0123456789abcdefghijklmnopqrstuvwxyz';
const STATE = join(root, '.wrangler', 'test-flow');
const wrangler = join(root, 'node_modules', '.bin', 'wrangler');

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function sql(command) {
  const out = execFileSync(wrangler, ['d1', 'execute', 'rregullo-launch', '--local', '--persist-to', STATE, '--json', '--command', command],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out)[0].results;
}

let ipCounter = 1;
const freshIp = () => `198.51.100.${ipCounter++}`;
async function subscribe(body, { ip = freshIp(), origin = BASE, json = true } = {}) {
  const res = await post(`${BASE}/api/subscribe`, {
    method: 'POST',
    headers: {
      'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded',
      Origin: origin, 'CF-Connecting-IP': ip,
    },
    body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* HTML */ }
  return { status: res.status, data, text };
}
// wrangler's dev server sometimes drops a kept-alive socket after a response that scheduled background
// work; browsers retry that transparently, so the test does too (once, and only on a socket error).
async function post(url, init) {
  try { return await fetch(url, init); } catch (e) {
    if (e.cause && e.cause.code === 'UND_ERR_SOCKET') return fetch(url, init);
    throw e;
  }
}
const confirmPost = (t) => post(`${BASE}/konfirmo`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE }, body: `t=${t}`,
});

async function main() {
  console.log('Building and starting the local stack…');
  execFileSync('node', ['scripts/build.mjs'], { cwd: root, stdio: 'ignore', env: { ...process.env, SITE_URL: BASE } });
  rmSync(STATE, { recursive: true, force: true });
  execFileSync(wrangler, ['d1', 'migrations', 'apply', 'rregullo-launch', '--local', '--persist-to', STATE], { cwd: root, stdio: 'ignore' });

  const mail = await startMockEmail(MAIL_PORT);
  const inbox = mail.messages;
  const dev = spawn(wrangler, ['dev', '--port', String(PORT), '--persist-to', STATE,
    '--var', `APP_SECRET:${SECRET}`, '--var', 'RESEND_API_KEY:re_test',
    '--var', `EMAIL_API_BASE:http://127.0.0.1:${MAIL_PORT}`, '--var', `SITE_URL:${BASE}`,
    '--var', 'LAUNCH_NOTIFICATION_EMAIL:team@example.test', '--var', 'LAUNCH_NOTIFY_ON:all'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' } });
  let devLog = '';
  dev.stdout.on('data', (d) => { devLog += d; });
  dev.stderr.on('data', (d) => { devLog += d; });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    console.log('Signup');
    await check('1. valid email with consent: saved on the list at once, no email to the visitor, team notified (masked)', async () => {
      const r = await subscribe({ email: '  Ana.Test@Example.com ', consent: true });
      assert(r.status === 200 && r.data.ok, `status ${r.status}`);
      assert(r.data.message === 'Faleminderit! Do të të lajmërojmë kur Rregullo të jetë gati.', 'success message');
      const [row] = sql("SELECT status, consent_version, consent_at, confirmed_at, confirm_token_hash FROM subscribers WHERE email = 'ana.test@example.com'");
      assert(row && row.status === 'confirmed' && row.consent_version === 'launch-notify-v1' && row.consent_at > 0 && row.confirmed_at > 0, 'saved with consent');
      assert(row.confirm_token_hash === null, 'no confirmation token');
      await wait(1500);
      assert(!inbox.some((m) => m.to[0] === 'ana.test@example.com'), 'no email to the visitor');
      const team = inbox.find((m) => m.to[0] === 'team@example.test');
      assert(team && team.text.includes('a***@e***.com') && !team.text.includes('ana.test@example.com'), 'masked team note');
      assert(sql("SELECT team_notify_status AS s FROM subscribers WHERE email = 'ana.test@example.com'")[0].s === 'sent', 'recorded as sent');
    });
    await check('2. missing email: rejected with a field message', async () => {
      const r = await subscribe({ email: '', consent: true });
      assert(r.status === 400 && r.data.errors.email === 'Shkruaje email adresën tënde.', JSON.stringify(r.data));
    });
    await check('3. invalid email format: rejected', async () => {
      for (const email of ['ana@', 'ana.example.com', 'ana@example', 'a b@example.com', 'ana@exa_mple.com', 'ana..x@example.com']) {
        const r = await subscribe({ email, consent: true });
        assert(r.status === 400 && r.data.errors.email, `${email} → ${r.status}`);
      }
    });
    await check('4. missing consent: rejected, nothing stored', async () => {
      for (const consent of [false, undefined, 'false', '']) {
        const r = await subscribe({ email: 'nocons@example.com', consent });
        assert(r.status === 400 && r.data.errors.consent, `consent=${consent} → ${r.status}`);
      }
      assert(sql("SELECT COUNT(*) AS n FROM subscribers WHERE email = 'nocons@example.com'")[0].n === 0, 'no row');
    });
    await check('5. duplicate signup: same answer, no duplicate row, no extra email', async () => {
      const before = inbox.length;
      const r = await subscribe({ email: 'ana.test@example.com', consent: true });
      assert(r.status === 200 && r.data.ok, `status ${r.status}`);
      assert(inbox.length === before, 'no second email');
      assert(sql("SELECT COUNT(*) AS n FROM subscribers WHERE email = 'ana.test@example.com'")[0].n === 1, 'one row');
    });
    await check('6a. honeypot filled: looks accepted, nothing stored or sent', async () => {
      const before = inbox.length;
      const r = await subscribe({ email: 'bot@example.com', consent: true, company_site: 'http://spam.example' });
      assert(r.status === 200 && r.data.ok, `status ${r.status}`);
      assert(inbox.length === before, 'no email');
      assert(sql("SELECT COUNT(*) AS n FROM subscribers WHERE email = 'bot@example.com'")[0].n === 0, 'no row');
    });
    await check('6b. repeated submissions from one IP: limited after 6 in 10 minutes', async () => {
      const ip = freshIp();
      const codes = [];
      for (let i = 0; i < 8; i++) codes.push((await subscribe({ email: `burst${i}@example.com`, consent: true }, { ip })).status);
      assert(codes.slice(0, 6).every((c) => c === 200) && codes[6] === 429 && codes[7] === 429, codes.join(','));
    });
    await check('6c. cross-site post (other Origin): refused', async () => {
      const r = await subscribe({ email: 'csrf@example.com', consent: true }, { origin: 'https://evil.example' });
      assert(r.status === 403, `status ${r.status}`);
      const lookalike = await subscribe({ email: 'csrf@example.com', consent: true }, { origin: `http://localhost.evil.example:${PORT}` });
      assert(lookalike.status === 403, `lookalike status ${lookalike.status}`);
    });
    await check('6f. page opened over http:// (request upgraded to https://): accepted and saved on the first post', async () => {
      // wrangler dev rewrites the Origin and URL to one scheme, so this calls the handler directly, the way production
      // sees it: Origin http://rregullo.net, URL https://rregullo.net/api/subscribe (Cloudflare ray a44225594ec2d0f7).
      const { getPlatformProxy } = await import('wrangler');
      const { onRequestPost } = await import('../functions/api/subscribe.js');
      const proxy = await getPlatformProxy({ persist: false });
      try {
        const db = proxy.env.DB;
        const schema = readFileSync(join(root, 'migrations', '0001_subscribers.sql'), 'utf8');
        for (const stmt of schema.replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(stmt).run();
        const env = { DB: db, SITE_URL: 'https://rregullo.net', APP_SECRET: SECRET, RESEND_API_KEY: 're_test', EMAIL_FROM: 'test@example.test' };
        const post = (origin, ip) => onRequestPost({ env, waitUntil() {}, request: new Request('https://rregullo.net/api/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, 'CF-Connecting-IP': ip },
          body: 'email=scheme%40example.com&consent=true',
        }) });
        const r = await post('http://rregullo.net', freshIp());
        assert(r.status === 200 && (await r.text()).includes('Faleminderit!'), `status ${r.status}`);
        const row = await db.prepare("SELECT status, consent_version FROM subscribers WHERE email = 'scheme@example.com'").first();
        assert(row && row.status === 'confirmed' && row.consent_version === 'launch-notify-v1', 'stored');
        for (const bad of ['https://evil.example', 'http://rregullo.net.evil.example', 'null']) {
          assert((await post(bad, freshIp())).status === 403, `${bad} refused`);
        }
      } finally {
        await proxy.dispose();
      }
    });
    await check('6d. oversized body: refused', async () => {
      const r = await subscribe({ email: 'big@example.com', consent: true, pad: 'x'.repeat(5000) });
      assert(r.status === 413, `status ${r.status}`);
    });
    await check('6e. wrong method: 405', async () => {
      assert((await fetch(`${BASE}/api/subscribe`)).status === 405, 'GET allowed');
    });

    console.log('Old confirmation links');
    await check('8c. malformed or made-up tokens: refused', async () => {
      assert((await confirmPost('abc')).status === 400, 'short');
      assert((await confirmPost('A'.repeat(43))).status === 400, 'unknown');
      assert((await fetch(`${BASE}/konfirmo?t=<script>`)).status === 400, 'GET junk');
    });

    console.log('Email outages');
    await check('12a. email provider down: the signup is still saved and accepted', async () => {
      mail.setFail(true);
      const r = await subscribe({ email: 'outage@example.com', consent: true }, { ip: freshIp() });
      assert(r.status === 200 && r.data.ok, `status ${r.status}`);
      assert(sql("SELECT status FROM subscribers WHERE email = 'outage@example.com'")[0].status === 'confirmed', 'saved');
      mail.setFail(false);
    });
    await check('12b. team notification outage: recorded as failed, retried later', async () => {
      mail.setFail(true);
      await subscribe({ email: 'teamfail@example.com', consent: true }, { ip: freshIp() });
      await wait(1500);
      assert(sql("SELECT team_notify_status AS s FROM subscribers WHERE email = 'teamfail@example.com'")[0].s === 'failed', 'marked failed');
      mail.setFail(false);
      sql("UPDATE subscribers SET updated_at = updated_at - 120000 WHERE email = 'teamfail@example.com'");
      await subscribe({ email: 'trigger@example.com', consent: true }, { ip: freshIp() });     // any request runs maintenance
      await wait(2000);
      assert(sql("SELECT team_notify_status AS s FROM subscribers WHERE email = 'teamfail@example.com'")[0].s === 'sent', 'retried and sent');
    });
    await check('12c. database failure: generic error, no false success', async () => {
      sql('ALTER TABLE subscribers RENAME TO subscribers_off');
      try {
        const r = await subscribe({ email: 'dbdown@example.com', consent: true }, { ip: freshIp() });
        assert(r.status === 500 && !r.data.ok && r.data.message === 'Diçka nuk shkoi si duhet. Provo përsëri pas pak.', `status ${r.status}`);
      } finally {
        sql('ALTER TABLE subscribers_off RENAME TO subscribers');
      }
    });

    console.log('Unsubscribe');
    const [{ id }] = sql("SELECT id FROM subscribers WHERE email = 'ana.test@example.com'");
    const sig = await unsubscribeSig(SECRET, id);
    await check('11a. unsubscribe link (GET) asks first and changes nothing', async () => {
      const r = await fetch(`${BASE}/cregjistrohu?s=${id}&t=${sig}`);
      assert(r.status === 200 && (await r.text()).includes('Po, çregjistrohu'), `status ${r.status}`);
      assert(sql(`SELECT status FROM subscribers WHERE id = '${id}'`)[0].status === 'confirmed', 'unchanged');
    });
    await check('11b. tampered unsubscribe link: refused', async () => {
      const bad = sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a');
      assert((await fetch(`${BASE}/cregjistrohu?s=${id}&t=${bad}`, { method: 'POST' })).status === 400, 'accepted a bad signature');
    });
    await check('11c. unsubscribe (POST): address deleted, hash kept for suppression', async () => {
      const r = await fetch(`${BASE}/cregjistrohu?s=${id}&t=${sig}`, { method: 'POST', headers: { Origin: BASE } });
      assert(r.status === 200 && (await r.text()).includes('U çregjistrove.'), `status ${r.status}`);
      const [row] = sql(`SELECT status, email, email_hash FROM subscribers WHERE id = '${id}'`);
      assert(row.status === 'unsubscribed' && row.email === null && row.email_hash, JSON.stringify(row));
      const confirmed = sql("SELECT COUNT(*) AS n FROM subscribers WHERE status = 'confirmed' AND email = 'ana.test@example.com'")[0].n;
      assert(confirmed === 0, 'not on the send list');
    });
    await check('11d. one-click unsubscribe from a mail app (RFC 8058)', async () => {
      const [{ id: id2 }] = sql("SELECT id FROM subscribers WHERE email = 'teamfail@example.com'");
      const r = await fetch(`${BASE}/cregjistrohu?s=${id2}&t=${await unsubscribeSig(SECRET, id2)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click',
      });
      assert(r.status === 200, `status ${r.status}`);
      assert(sql(`SELECT status FROM subscribers WHERE id = '${id2}'`)[0].status === 'unsubscribed', 'unsubscribed');
    });
    await check('11e. signing up again after unsubscribing: back on the list with fresh consent', async () => {
      const r = await subscribe({ email: 'ana.test@example.com', consent: true }, { ip: freshIp() });
      assert(r.status === 200, `status ${r.status}`);
      const [row] = sql(`SELECT status, email, unsubscribed_at FROM subscribers WHERE id = '${id}'`);
      assert(row.status === 'confirmed' && row.email === 'ana.test@example.com' && row.unsubscribed_at === null, JSON.stringify(row));
    });

    console.log('Without JavaScript and retention');
    await check('13. plain form post (no JavaScript) gets an HTML result page', async () => {
      const r = await subscribe({ email: 'nojs@example.com', consent: 'true' }, { json: false, ip: freshIp() });
      assert(r.status === 200 && r.text.includes('Faleminderit!'), `status ${r.status}`);
      const bad = await subscribe({ email: 'nojs2@example.com' }, { json: false });
      assert(bad.status === 400 && bad.text.includes('pranosh'), 'consent error page');
    });
    await check('14. retention: old pending rows (from the double opt-in days) are deleted after 7 days', async () => {
      sql("UPDATE subscribers SET status = 'pending', updated_at = 1 WHERE email = 'outage@example.com'");
      await subscribe({ email: 'trigger2@example.com', consent: true }, { ip: freshIp() });
      await wait(1500);
      assert(sql("SELECT COUNT(*) AS n FROM subscribers WHERE email = 'outage@example.com'")[0].n === 0, 'still there');
    });
    await check('15. logs contain no addresses or tokens', async () => {
      assert(!/@example\.com/.test(devLog), 'an address appears in the logs');
    });
  } finally {
    dev.kill('SIGTERM');
    mail.server.close();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
