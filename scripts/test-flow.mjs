// End-to-end test of the signup flow against the real Functions and a local D1 database,
// with scripts/mock-email.mjs standing in for Resend. Nothing is sent to real inboxes.
//   npm test
// It builds the site, starts `wrangler dev` on port 8789 with a fresh database, runs every case,
// and stops everything again.

import { spawn, execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
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
const tokenFrom = (msg) => (msg.text.match(/konfirmo\?t=([A-Za-z0-9_-]{43})/) || [])[1];
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
    let token;
    await check('1. valid email with consent: accepted, pending, one confirmation email', async () => {
      const r = await subscribe({ email: '  Ana.Test@Example.com ', consent: true });
      assert(r.status === 200 && r.data.ok, `status ${r.status}`);
      assert(r.data.message === 'Edhe një hap! Kontrollo emailin për me e konfirmu adresën.', 'success message');
      assert(inbox.length === 1 && inbox[0].to[0] === 'ana.test@example.com', 'confirmation email to the normalised address');
      assert(inbox[0].subject === 'Konfirmo emailin për lansimin e Rregullo', 'subject');
      token = tokenFrom(inbox[0]);
      assert(token, 'token in the confirmation link');
      assert(!inbox[0].text.includes('ana.test'), 'the link does not contain the address');
      const [row] = sql("SELECT status, consent_version, consent_at, confirm_token_hash, email FROM subscribers WHERE email = 'ana.test@example.com'");
      assert(row && row.status === 'pending' && row.consent_version === 'launch-notify-v1' && row.consent_at > 0, 'pending row with consent');
      assert(row.confirm_token_hash && row.confirm_token_hash !== token, 'only the token hash is stored');
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
    await check('5. duplicate signup: same answer, no duplicate row, no extra email within 2 minutes', async () => {
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
    });
    await check('6d. oversized body: refused', async () => {
      const r = await subscribe({ email: 'big@example.com', consent: true, pad: 'x'.repeat(5000) });
      assert(r.status === 413, `status ${r.status}`);
    });
    await check('6e. wrong method: 405', async () => {
      assert((await fetch(`${BASE}/api/subscribe`)).status === 405, 'GET allowed');
    });

    console.log('Confirmation');
    await check('7a. opening the link (GET) shows a page but does not confirm', async () => {
      const r = await fetch(`${BASE}/konfirmo?t=${token}`);
      const html = await r.text();
      assert(r.status === 200 && html.includes('name="t"') && html.includes('data-autosubmit'), 'confirm form');
      assert(r.headers.get('referrer-policy') === 'no-referrer', 'no-referrer');
      assert(sql("SELECT status FROM subscribers WHERE email = 'ana.test@example.com'")[0].status === 'pending', 'still pending');
    });
    await check('7b. confirming (POST) activates the subscription and notifies the team (masked)', async () => {
      const before = inbox.length;
      const r = await confirmPost(token);
      const html = await r.text();
      assert(r.status === 200 && html.includes('Emaili u konfirmua. Do të të lajmërojmë kur Rregullo të jetë gati.'), `status ${r.status}`);
      const [row] = sql("SELECT status, confirmed_at, confirm_token_hash FROM subscribers WHERE email = 'ana.test@example.com'");
      assert(row.status === 'confirmed' && row.confirmed_at > 0 && row.confirm_token_hash === null, 'confirmed, token cleared');
      await wait(1500);
      const team = inbox.slice(before).find((m) => m.to[0] === 'team@example.test');
      assert(team, 'team email');
      assert(team.text.includes('a***@e***.com') && !team.text.includes('ana.test@example.com'), 'masked address');
      assert(team.text.includes('I konfirmuar'), 'status line');
      assert(sql("SELECT team_notify_status AS s FROM subscribers WHERE email = 'ana.test@example.com'")[0].s === 'sent', 'recorded as sent');
    });
    await check('8a. reusing a confirmation link: refused', async () => {
      const r = await confirmPost(token);
      assert(r.status === 400 && (await r.text()).includes('Kjo lidhje nuk vlen më.'), `status ${r.status}`);
    });
    await check('8b. expired link: refused with a way to sign up again', async () => {
      await subscribe({ email: 'late@example.com', consent: true });
      const t = tokenFrom(inbox[inbox.length - 1]);
      sql("UPDATE subscribers SET confirm_expires_at = 1 WHERE email = 'late@example.com'");
      const r = await confirmPost(t);
      assert(r.status === 410 && (await r.text()).includes('Kjo lidhje ka skaduar.'), `status ${r.status}`);
      assert(sql("SELECT status FROM subscribers WHERE email = 'late@example.com'")[0].status === 'pending', 'not confirmed');
    });
    await check('8c. malformed or made-up tokens: refused', async () => {
      assert((await confirmPost('abc')).status === 400, 'short');
      assert((await confirmPost('A'.repeat(43))).status === 400, 'unknown');
      assert((await fetch(`${BASE}/konfirmo?t=<script>`)).status === 400, 'GET junk');
    });
    await check('8d. already-confirmed address signs up again: same answer, no email', async () => {
      const before = inbox.length;
      const r = await subscribe({ email: 'ana.test@example.com', consent: true });
      assert(r.status === 200 && r.data.ok && inbox.length === before, 'generic, silent');
    });

    console.log('Email delivery');
    await check('9. confirmation email: Albanian copy, button link, plain-text part, privacy link', async () => {
      const m = inbox.find((x) => x.to[0] === 'late@example.com');
      for (const s of ['Përshëndetje!', 'Faleminderit për interesimin për Rregullo.', 'Konfirmo emailin', 'Me respekt,', 'Ekipi Rregullo',
        'Ky email është dërguar sepse ke kërkuar të njoftohesh rreth lansimit të Rregullo.']) {
        assert(m.html.includes(s), `html missing: ${s}`);
      }
      assert(m.text.includes(`${BASE}/konfirmo?t=`) && m.text.includes(`${BASE}/privatesia`), 'links in text part');
      assert(m.from.includes('Rregullo'), 'sender');
    });
    await check('10. team notifications: one on signup, one on confirmation, only to LAUNCH_NOTIFICATION_EMAIL', async () => {
      const team = inbox.filter((m) => m.to[0] === 'team@example.test');
      const requested = team.filter((m) => m.subject === 'Rregullo: kërkesë e re për njoftim');
      const confirmed = team.filter((m) => m.subject === 'Rregullo: regjistrim i ri i konfirmuar');
      assert(confirmed.length === 1, `confirmation notes: ${confirmed.length}`);
      assert(requested.length >= 1 && requested[0].text.includes('Në pritje të konfirmimit') && requested[0].text.includes('a***@e***.com'), 'signup note');
      assert(team.every((m) => !/[a-z0-9.]+@example\.com/.test(m.text)), 'a full address appears in a team note');
    });
    await check('12a. provider outage: error shown, record kept, retry sends a fresh link', async () => {
      mail.setFail(true);
      const ip = freshIp();
      const r = await subscribe({ email: 'outage@example.com', consent: true }, { ip });
      assert(r.status === 502 && !r.data.ok && r.data.message === 'Diçka nuk shkoi si duhet. Provo përsëri pas pak.', `status ${r.status}`);
      const [row] = sql("SELECT status, confirm_email_status AS s, confirm_sent_count AS n FROM subscribers WHERE email = 'outage@example.com'");
      assert(row.status === 'pending' && row.s === 'failed' && row.n === 0, JSON.stringify(row));
      mail.setFail(false);
      const before = inbox.length;
      const r2 = await subscribe({ email: 'outage@example.com', consent: true }, { ip });
      assert(r2.status === 200 && inbox.length === before + 1, 'retry delivered');
    });
    await check('12b. team notification outage: recorded as failed, retried later', async () => {
      await subscribe({ email: 'teamfail@example.com', consent: true });
      const t = tokenFrom(inbox[inbox.length - 1]);
      mail.setFail(true);
      assert((await confirmPost(t)).status === 200, 'confirmation still succeeds');
      await wait(1500);
      assert(sql("SELECT team_notify_status AS s FROM subscribers WHERE email = 'teamfail@example.com'")[0].s === 'failed', 'marked failed');
      mail.setFail(false);
      sql("UPDATE subscribers SET updated_at = updated_at - 120000 WHERE email = 'teamfail@example.com'");
      await subscribe({ email: 'trigger@example.com', consent: true });     // any request runs maintenance
      await wait(2000);
      assert(sql("SELECT team_notify_status AS s FROM subscribers WHERE email = 'teamfail@example.com'")[0].s === 'sent', 'retried and sent');
    });
    await check('12c. database failure: generic error, no false success', async () => {
      sql('ALTER TABLE subscribers RENAME TO subscribers_off');
      try {
        const r = await subscribe({ email: 'dbdown@example.com', consent: true });
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
    await check('11e. signing up again after unsubscribing: back to pending, needs a new confirmation', async () => {
      const r = await subscribe({ email: 'ana.test@example.com', consent: true });
      assert(r.status === 200, `status ${r.status}`);
      const [row] = sql(`SELECT status, email FROM subscribers WHERE id = '${id}'`);
      assert(row.status === 'pending' && row.email === 'ana.test@example.com', JSON.stringify(row));
    });

    console.log('Without JavaScript and retention');
    await check('13. plain form post (no JavaScript) gets an HTML result page', async () => {
      const r = await subscribe({ email: 'nojs@example.com', consent: 'true' }, { json: false });
      assert(r.status === 200 && r.text.includes('Edhe një hap!'), `status ${r.status}`);
      const bad = await subscribe({ email: 'nojs2@example.com' }, { json: false });
      assert(bad.status === 400 && bad.text.includes('pranosh'), 'consent error page');
    });
    await check('14. retention: unconfirmed signups older than 7 days are deleted', async () => {
      sql("UPDATE subscribers SET updated_at = 1 WHERE email = 'late@example.com'");
      await subscribe({ email: 'trigger2@example.com', consent: true });
      await wait(1500);
      assert(sql("SELECT COUNT(*) AS n FROM subscribers WHERE email = 'late@example.com'")[0].n === 0, 'still there');
    });
    await check('15. logs contain no addresses or tokens', async () => {
      assert(!/@example\.com/.test(devLog), 'an address appears in the logs');
      assert(!devLog.includes(token), 'a token appears in the logs');
    });
  } finally {
    dev.kill('SIGTERM');
    mail.server.close();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
