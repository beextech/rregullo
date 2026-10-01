// One-command deploy to the Worker's public workers.dev address (no custom domain, no DNS changes).
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… [RESEND_API_KEY=…] [LAUNCH_NOTIFICATION_EMAIL=…] npm run deploy:auto
//
// It is safe to run again. In order, it:
//   1. finds the D1 database `rregullo-launch`, creating it in Western Europe (weur) if it doesn't exist,
//      and writes its real id into wrangler.toml;
//   2. looks up the account's workers.dev subdomain and sets SITE_URL in wrangler.toml to the Worker's address;
//   3. applies the migrations to the remote database;
//   4. builds dist/ and deploys the Worker;
//   5. stores the secrets on the Worker: RESEND_API_KEY and LAUNCH_NOTIFICATION_EMAIL when given, and an
//      APP_SECRET generated here only if the Worker doesn't have one yet (it must never change after launch);
//   6. checks that the live page and its assets load.
//
// Secret values are passed to wrangler through a temporary file readable only by this user, deleted right
// after, and never printed. The API token needs: Workers Scripts Edit, D1 Edit, Account Settings Read.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKER = 'rregullo';
const DB_NAME = 'rregullo-launch';
const DB_LOCATION = 'weur';
const TOML = new URL('../wrangler.toml', import.meta.url);

const env = process.env;
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };
const step = (msg) => console.log(`\n▸ ${msg}`);

for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
  if (!env[name]) fail(`${name} is not set.`);
}

function wrangler(args, { quiet = false, input } = {}) {
  return execFileSync('npx', ['--no-install', 'wrangler', ...args], {
    encoding: 'utf8',
    env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', quiet ? 'pipe' : 'inherit'],
  });
}

function setToml(pattern, line, what) {
  const src = readFileSync(TOML, 'utf8');
  if (!pattern.test(src)) fail(`Couldn't find ${what} in wrangler.toml.`);
  writeFileSync(TOML, src.replace(pattern, line));
}

// 1. D1 database
step(`D1 database ${DB_NAME}`);
const findDb = () => JSON.parse(wrangler(['d1', 'list', '--json'], { quiet: true })).find((d) => d.name === DB_NAME);
let db = findDb();
if (db) {
  console.log(`  exists: ${db.uuid}`);
} else {
  wrangler(['d1', 'create', DB_NAME, `--location=${DB_LOCATION}`], { quiet: true });
  db = findDb();
  if (!db) fail(`Created ${DB_NAME}, but it doesn't show up in \`wrangler d1 list\`.`);
  console.log(`  created in ${DB_LOCATION}: ${db.uuid}`);
}
setToml(/^database_id = ".*"$/m, `database_id = "${db.uuid}"`, 'database_id');

// 2. workers.dev address
step('workers.dev address');
const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/subdomain`, {
  headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
});
const body = await res.json().catch(() => ({}));
const subdomain = body?.result?.subdomain;
if (!subdomain) {
  fail('This account has no workers.dev subdomain yet. Open Workers & Pages in the Cloudflare dashboard once '
    + '(it asks you to pick one), then run this again.'
    + (body?.errors?.length ? `\n  Cloudflare said: ${body.errors.map((e) => e.message).join('; ')}` : ''));
}
const siteUrl = `https://${WORKER}.${subdomain}.workers.dev`;
setToml(/^SITE_URL = ".*"$/m, `SITE_URL = "${siteUrl}"`, 'SITE_URL');
console.log(`  ${siteUrl}`);

// 3. Migrations
step('Migrations (remote)');
wrangler(['d1', 'migrations', 'apply', DB_NAME, '--remote']);

// 4. Build and deploy
step('Build');
execFileSync('node', ['scripts/build.mjs'], { stdio: 'inherit', env: { ...env, SITE_URL: siteUrl } });
step('Deploy');
wrangler(['deploy']);

// 5. Secrets
step('Secrets');
const existing = new Set(JSON.parse(wrangler(['secret', 'list', '--format', 'json'], { quiet: true })).map((s) => s.name));
const secrets = {};
if (!existing.has('APP_SECRET')) secrets.APP_SECRET = randomBytes(32).toString('base64url');
if (env.RESEND_API_KEY) secrets.RESEND_API_KEY = env.RESEND_API_KEY;
if (env.LAUNCH_NOTIFICATION_EMAIL) secrets.LAUNCH_NOTIFICATION_EMAIL = env.LAUNCH_NOTIFICATION_EMAIL;
if (Object.keys(secrets).length) {
  const dir = mkdtempSync(join(tmpdir(), 'rregullo-secrets-'));
  const file = join(dir, 'secrets.json');
  try {
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    wrangler(['secret', 'bulk', file], { quiet: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
for (const name of ['APP_SECRET', 'RESEND_API_KEY', 'LAUNCH_NOTIFICATION_EMAIL']) {
  const state = name in secrets ? 'set now' : existing.has(name) ? 'already set' : 'MISSING';
  console.log(`  ${name}: ${state}`);
}
if (!secrets.RESEND_API_KEY && !existing.has('RESEND_API_KEY')) {
  console.log('  Without RESEND_API_KEY the signup form answers 503 and nothing is stored.');
}

// 6. Smoke test
step('Live check');
let bad = 0;
for (const path of ['/', '/site.css', '/site.js', '/media/og-image.png', '/fonts/schibsted-grotesk-latin.woff2']) {
  let status = 0;
  for (let i = 0; i < 5 && status !== 200; i++) {
    if (i) await new Promise((r) => setTimeout(r, 3000));
    status = await fetch(siteUrl + path).then((r) => r.status, () => 0);
  }
  if (status !== 200) bad++;
  console.log(`  ${status === 200 ? '✓' : '✗'} ${path} ${status || 'no response'}`);
}
console.log(`\n${bad ? '✗ Deployed, but some checks failed' : '✓ Live'}: ${siteUrl}`);
console.log('  wrangler.toml now holds the D1 id and SITE_URL: commit it.');
process.exit(bad ? 1 : 0);
