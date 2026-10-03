#!/usr/bin/env node
/**
 * CSP "upgrade-insecure-requests" regression test (offline).
 *
 * On a plain-HTTP LAN page (e.g. http://192.168.x.x:3000), a CSP with
 * "upgrade-insecure-requests" makes the browser rewrite relative subresource
 * URLs (e.g. /dist/styles.css, /assets/logo.svg) to HTTPS before requesting
 * them. The local Node server has no TLS listener, so those HTTPS attempts
 * fail silently and the page renders unstyled. The directive must stay OFF
 * in development (NODE_ENV !== 'production') and ON in production, where
 * Render's load balancer terminates real HTTPS.
 *
 * Isolated child scenarios (each: temp DB, provider credentials blanked,
 * outbound network blocked). Run: node test/csp-upgrade-insecure.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const cp = require('child_process');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const MODES = { dev: 34681, prod: 34682 };

function parent() {
  let pass = 0, fail = 0;
  for (const mode of Object.keys(MODES)) {
    const r = cp.spawnSync(process.execPath, [__filename, mode], { cwd: ROOT, encoding: 'utf8', env: { ...process.env } });
    const lines = (r.stdout || '').split(/\r?\n/).filter((l) => /^(PASS|FAIL): /.test(l));
    lines.forEach((l) => { console.log(`[${mode}] ${l}`); l.startsWith('PASS') ? pass++ : fail++; });
    if (r.status !== 0 || lines.length === 0) { console.log(`FAIL: [${mode}] child exited ${r.status}\n${(r.stderr || '').slice(0, 400)}`); fail++; }
  }
  console.log(`\nPASS: ${pass}  FAIL: ${fail}  TOTAL: ${pass + fail}`);
  process.exit(fail ? 1 : 0);
}

async function child(mode) {
  const PORT = MODES[mode];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-upgrade-'));
  const prod = mode === 'prod';
  Object.assign(process.env, {
    TEST_DB_PATH: path.join(tmpDir, 'csp.sqlite'), PORT: String(PORT), FRONTEND_URL: `http://127.0.0.1:${PORT}`,
    NODE_ENV: prod ? 'production' : 'development', LAUNCH_MODE: 'waitlist', TEST_MODE: 'false',
    SESSION_SECRET: 'csp-test-secret-csp-test-secret-123456',
    ANTHROPIC_API_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', RESEND_API_KEY: '',
  });

  const captured = [];
  for (const k of ['log', 'info', 'warn', 'error']) console[k] = (...a) => captured.push(a.map(String).join(' '));
  process.stdout.write = () => true; process.stderr.write = () => true;
  const out = (s) => fs.writeSync(1, s + '\n');

  const outbound = [];
  const of = global.fetch;
  global.fetch = (u, ...a) => { if (!/^(https?:\/\/)?(127\.0\.0\.1|localhost)/.test(String(u && u.url ? u.url : u))) { outbound.push(String(u)); return Promise.reject(new Error('blocked')); } return of(u, ...a); };
  for (const m of ['request', 'get']) https[m] = () => { outbound.push('https.' + m); throw new Error('blocked'); };

  const csPath = require.resolve(path.join(ROOT, 'src/services/claudeService'));
  require.cache[csPath] = { id: csPath, filename: csPath, loaded: true, exports: { extractInvoiceData: async () => ({ records: [], truncated: false, extractedCount: 0 }) } };

  require(path.join(ROOT, 'src/server.js'));
  const database = require(path.join(ROOT, 'src/services/database'));
  await new Promise((r) => setTimeout(r, 300));

  let pass = 0, fail = 0;
  const t = async (name, fn) => { try { await fn(); out('PASS: ' + name); pass++; } catch (e) { out('FAIL: ' + name + ' :: ' + e.message); fail++; } };
  const req = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(ch).toString('utf8') }));
    }).on('error', reject);
  });

  const csp = (await req('/')).headers['content-security-policy'] || '';

  if (!prod) {
    await t('T1 development CSP does NOT contain upgrade-insecure-requests', async () => {
      assert.ok(!/upgrade-insecure-requests/.test(csp), 'directive present in development: ' + csp);
    });
  } else {
    await t('T2 production CSP DOES contain upgrade-insecure-requests', async () => {
      assert.ok(/upgrade-insecure-requests/.test(csp), 'directive missing in production: ' + csp);
    });
  }

  await t('T3 other important CSP directives remain present', async () => {
    for (const must of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self'", "font-src 'self'", "frame-src https://js.stripe.com", "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'"]) {
      assert.ok(csp.includes(must), `missing directive fragment: ${must} :: full CSP: ${csp}`);
    }
  });

  await t("T4 local CSS path remains allowed by style-src 'self'", async () => {
    const r = await req('/dist/styles.css');
    assert.strictEqual(r.status, 200, 'CSS did not return 200');
    assert.ok(csp.includes("style-src 'self'"), 'style-src self missing');
  });

  await t("T5 logo path remains allowed by img-src 'self'", async () => {
    const r = await req('/assets/logo.svg');
    assert.strictEqual(r.status, 200, 'logo did not return 200');
    assert.ok(csp.includes("img-src 'self'"), 'img-src self missing');
  });

  await t('T6 zero outbound network attempts (Anthropic/Stripe/Resend/any)', async () => { assert.deepStrictEqual(outbound, []); });

  try { database.db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(fail ? 1 : 0);
}

const mode = process.argv[2];
if (!mode) parent();
else child(mode).catch((e) => { fs.writeSync(1, 'FAIL: child crashed ' + e.message + '\n'); process.exit(1); });
