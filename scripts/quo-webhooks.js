#!/usr/bin/env node
// ── quo-webhooks.js — register / list / delete Quo webhooks ──────────────────
//
//   node scripts/quo-webhooks.js list
//   node scripts/quo-webhooks.js register <base-url>
//   node scripts/quo-webhooks.js delete <webhook-id>
//
// `register` points Quo's four event families at <base-url>/api/quo-webhook,
// with the shared secret in the query string.
//
// Point it at a PREVIEW deployment first. Webhooks registered against a preview
// URL keep firing at that deployment, so the whole path can be exercised with a
// real call before anything touches production — then re-register against the
// production domain and delete the preview hooks.
//
// Reads QUO_API_KEY and QUO_WEBHOOK_SECRET from .env.local (pull them with
// `vercel env pull .env.local`). Nothing is created without an explicit
// subcommand.

const fs = require('fs');
const path = require('path');

// Load .env.local if present, without overwriting anything already exported.
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)="?(.*?)"?\s*$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const quo = require(path.join(__dirname, '..', 'api', '_quo.js'));

// One registration per event family — Quo has a separate path for each rather
// than one endpoint with a type field.
const FAMILIES = [
  { kind: 'calls',            events: ['call.completed', 'call.ringing'] },
  { kind: 'call-summaries',   events: ['call.summary.completed'] },
  { kind: 'call-transcripts', events: ['call.transcript.completed'] },
  { kind: 'messages',         events: ['message.received', 'message.delivered'] },
];

function redact(url) {
  return String(url).replace(/secret=[^&]+/, 'secret=<redacted>');
}

async function list() {
  const res = await quo.listWebhooks();
  if (!res.ok) { console.error('Failed to list webhooks:', res.error); process.exit(1); }
  const hooks = Array.isArray(res.data) ? res.data : (res.data && res.data.data) || [];
  if (!hooks.length) { console.log('No webhooks registered.'); return; }
  console.log(`${hooks.length} webhook(s):\n`);
  for (const h of hooks) {
    console.log(`  ${h.id}`);
    console.log(`    url    ${redact(h.url)}`);
    console.log(`    events ${(h.events || []).join(', ') || '(all)'}`);
    console.log(`    status ${h.status || h.state || 'unknown'}\n`);
  }
}

async function register(baseUrl) {
  const secret = process.env.QUO_WEBHOOK_SECRET;
  if (!secret) { console.error('QUO_WEBHOOK_SECRET is not set.'); process.exit(1); }
  if (!/^https:\/\//.test(baseUrl)) {
    console.error('Base URL must be https — Quo will not deliver to http.');
    process.exit(1);
  }

  const target = `${baseUrl.replace(/\/+$/, '')}/api/quo-webhook?secret=${encodeURIComponent(secret)}`;
  console.log('Registering against', redact(target), '\n');

  for (const f of FAMILIES) {
    const res = await quo.createWebhook(f.kind, target, {
      events: f.events,
      label: `Auto Pals — ${f.kind}`,
    });
    if (res.ok) {
      const id = (res.data && (res.data.id || res.data.data?.id)) || '(no id returned)';
      console.log(`  ✓ ${f.kind.padEnd(18)} ${id}`);
    } else {
      console.log(`  ✗ ${f.kind.padEnd(18)} ${res.status} ${res.error}`);
      if (res.status === 403) {
        console.log('     403 usually means the plan — summaries and transcripts are Business/Scale only.');
      }
    }
  }
  console.log('\nMake a test call, then check the row landed:');
  console.log("  select ts, channel, direction, phone, outcome, request_id from communications where provider = 'quo' order by ts desc limit 5;");
}

async function remove(id) {
  if (!id) { console.error('usage: quo-webhooks.js delete <webhook-id>'); process.exit(1); }
  const res = await quo.deleteWebhook(id);
  console.log(res.ok ? `Deleted ${id}` : `Failed: ${res.status} ${res.error}`);
}

(async () => {
  if (!quo.hasApiKey()) {
    console.error('QUO_API_KEY not found. Run: vercel env pull .env.local');
    process.exit(1);
  }
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'list') return list();
  if (cmd === 'register') {
    if (!arg) { console.error('usage: quo-webhooks.js register <https://base-url>'); process.exit(1); }
    return register(arg);
  }
  if (cmd === 'delete') return remove(arg);
  console.log('usage: quo-webhooks.js <list|register <base-url>|delete <id>>');
})();
