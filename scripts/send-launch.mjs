// Sends the launch announcement to confirmed subscribers, one email per person (nobody sees anyone
// else's address), each with its own unsubscribe link and one-click unsubscribe headers.
//
// It never runs on its own and never runs by accident:
//   * Without --send it is a dry run: it counts recipients and prints a masked sample.
//   * --send also requires --i-confirm-rregullo-is-live, because the email says Rregullo is available.
//   * --preview-to you@example.com sends one copy to you and touches nothing else.
// Re-running is safe: everyone who received it is marked (launch_sent_at) and skipped next time.
//
// Needs, in the environment (the same values as production; keep them out of your shell history):
//   APP_SECRET, RESEND_API_KEY, EMAIL_FROM   e.g. "Rregullo <njoftime@rregullo.net>"
//   SITE_URL (default https://rregullo.net)  LAUNCH_URL (default SITE_URL): where "Hape Rregullo" points
// and a logged-in wrangler (`npx wrangler login`) for the production database.
//
//   node scripts/send-launch.mjs                                   dry run
//   node scripts/send-launch.mjs --preview-to you@example.com      one preview
//   node scripts/send-launch.mjs --send --i-confirm-rregullo-is-live
// Add --local to use the local development database instead of production.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unsubscribeSig } from '../server/crypto.js';
import { sendEmail } from '../server/email.js';
import { launchEmail } from '../server/templates.js';
import { maskEmail } from '../server/validate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const env = process.env;
const siteUrl = (env.SITE_URL || 'https://rregullo.net').replace(/\/$/, '');
const launchUrl = env.LAUNCH_URL || `${siteUrl}/`;
const where = flag('--local') ? '--local' : '--remote';
const persist = value('--persist-to');
const wrangler = join(root, 'node_modules', '.bin', 'wrangler');

function die(msg) { console.error(`send-launch: ${msg}`); process.exit(1); }
for (const k of ['APP_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM']) if (!env[k]) die(`${k} is not set`);
for (const u of [siteUrl, launchUrl]) if (!/^https:\/\//.test(u) && where === '--remote') die(`${u} must be https`);

function sql(command) {
  const extra = persist ? ['--persist-to', persist] : [];
  const out = execFileSync(wrangler, ['d1', 'execute', 'rregullo-launch', where, ...extra, '--json', '--command', command],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  return JSON.parse(out)[0].results;
}

const emailCfg = { apiKey: env.RESEND_API_KEY, apiBase: (env.EMAIL_API_BASE || 'https://api.resend.com').replace(/\/$/, ''), from: env.EMAIL_FROM, replyTo: env.EMAIL_REPLY_TO || '' };

async function build(id) {
  const unsubscribeUrl = `${siteUrl}/cregjistrohu?s=${encodeURIComponent(id)}&t=${await unsubscribeSig(env.APP_SECRET, id)}`;
  const msg = launchEmail({ siteUrl, launchUrl, unsubscribeUrl });
  msg.headers = { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  return msg;
}

const preview = value('--preview-to');
if (preview) {
  const msg = await build('00000000-0000-4000-8000-000000000000');   // its unsubscribe link matches nobody
  await sendEmail(emailCfg, { to: preview, ...msg });
  console.log(`Preview sent to ${maskEmail(preview)}. Nothing else was sent or changed.`);
  process.exit(0);
}

const rows = sql("SELECT id, email FROM subscribers WHERE status = 'confirmed' AND email IS NOT NULL AND launch_sent_at IS NULL ORDER BY confirmed_at");
console.log(`${rows.length} confirmed subscriber(s) have not received the launch email yet.`);
if (!flag('--send')) {
  rows.slice(0, 5).forEach((r) => console.log(`  ${maskEmail(r.email)}`));
  console.log('Dry run: nothing sent. Add --send --i-confirm-rregullo-is-live to send.');
  process.exit(0);
}
if (!flag('--i-confirm-rregullo-is-live')) die('refusing to send: add --i-confirm-rregullo-is-live once the platform is actually available');

const UUID = /^[0-9a-f-]{36}$/;
let sent = 0, failed = 0;
let done = [];
const flush = () => {
  if (!done.length) return;
  // ids are server-generated UUIDs (checked above), so inlining them here is safe
  sql(`UPDATE subscribers SET launch_sent_at = ${Date.now()} WHERE launch_sent_at IS NULL AND id IN (${done.map((id) => `'${id}'`).join(',')})`);
  done = [];
};
for (const r of rows) {
  if (!UUID.test(r.id)) { failed++; continue; }
  try {
    await sendEmail(emailCfg, { to: r.email, ...(await build(r.id)), idempotencyKey: `launch-${r.id}` });
    done.push(r.id); sent++;
  } catch (e) {
    failed++;
    console.log(`  failed: ${maskEmail(r.email)} (${e.message}); it stays unmarked, so a re-run retries it`);
  }
  if (done.length >= 25) flush();
  await new Promise((res) => setTimeout(res, 550));     // stay under the provider's default rate limit
}
flush();
console.log(`Done: ${sent} sent, ${failed} failed.`);
