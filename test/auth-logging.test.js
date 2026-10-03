#!/usr/bin/env node
/**
 * Magic-link token logging regression test (offline, no real email).
 *
 * The parent runs 4 isolated child scenarios of this same file:
 *   dev          Resend not configured, NODE_ENV=development
 *   prod         Resend not configured, NODE_ENV=production
 *   mock         Resend "configured" but replaced by an in-memory stub (success + failing send)
 *   devnosecret  SESSION_SECRET unset in development (auto-generated secret)
 * Each child uses an isolated temp DB, blanked provider credentials (set to ''
 * so dotenv cannot overwrite them), blocked outbound network, and captures
 * EVERYTHING written via console.* / process.stdout / process.stderr, then
 * asserts that no bearer credential (token, token URL, session JWT, secret
 * material) appears. Run: node test/auth-logging.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const cp = require('child_process');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const MODES = { dev: 34661, prod: 34662, mock: 34663, devnosecret: 34664 };

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-logging-'));
  const prod = mode === 'prod';
  Object.assign(process.env, {
    TEST_DB_PATH: path.join(tmpDir, 'auth.sqlite'), PORT: String(PORT), FRONTEND_URL: `http://127.0.0.1:${PORT}`,
    NODE_ENV: prod ? 'production' : 'development', LAUNCH_MODE: 'waitlist', TEST_MODE: 'true', TEST_DAILY_EXTRACTION_LIMIT: '1000',
    RATE_LIMIT_MAX_REQUESTS: '100000', SESSION_SECRET: mode === 'devnosecret' ? '' : 'auth-log-test-secret-auth-log-test-secret-12345',
    ANTHROPIC_API_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '',
    RESEND_API_KEY: mode === 'mock' ? 're_mock_not_a_real_key_000000' : '',
  });

  // ---- full output capture ----
  const captured = [];
  const out = (s) => fs.writeSync(1, s + '\n');
  process.stdout.write = (c, ...a) => { captured.push(String(c)); return true; };
  process.stderr.write = (c, ...a) => { captured.push(String(c)); return true; };
  for (const k of ['log', 'info', 'warn', 'error']) console[k] = (...a) => captured.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  const logs = () => captured.join('\n');

  // ---- outbound guard ----
  const outbound = [];
  const of = global.fetch;
  global.fetch = (u, ...a) => { if (!/^(https?:\/\/)?(127\.0\.0\.1|localhost)/.test(String(u && u.url ? u.url : u))) { outbound.push(String(u)); return Promise.reject(new Error('blocked')); } return of(u, ...a); };
  for (const m of ['request', 'get']) https[m] = () => { outbound.push('https.' + m); throw new Error('blocked'); };

  // ---- stubs: Anthropic always; Resend only in mock mode ----
  const csPath = require.resolve(path.join(ROOT, 'src/services/claudeService'));
  require.cache[csPath] = { id: csPath, filename: csPath, loaded: true, exports: { extractInvoiceData: async (b, m, fn) => ({ records: [{ supplier: 'S', subtotal: 1, vat_amount: 0, total: 1, currency: 'EUR', math_verified: true, source_file: fn }], truncated: false, extractedCount: 1 }) } };
  const sent = []; let failNext = false;
  if (mode === 'mock') {
    const rp = require.resolve('resend', { paths: [ROOT] });
    class Resend { constructor() { this.emails = { send: async (p) => { sent.push(p); if (failNext) throw new Error('provider rejected message body: ' + p.text); return { id: 'x' }; } }; } }
    require.cache[rp] = { id: rp, filename: rp, loaded: true, exports: { Resend } };
  }

  require(path.join(ROOT, 'src/server.js'));
  const database = require(path.join(ROOT, 'src/services/database'));
  const jwt = require(path.join(ROOT, 'node_modules/jsonwebtoken'));
  await new Promise((r) => setTimeout(r, 300));

  let pass = 0, fail = 0;
  const t = async (name, fn) => { try { await fn(); out('PASS: ' + name); pass++; } catch (e) { out('FAIL: ' + name + ' :: ' + e.message); fail++; } };
  const req = (method, p, headers, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { ...(headers || {}), ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c));
      res.on('end', () => { const text = Buffer.concat(ch).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (e) { /* */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    }); r.on('error', reject); if (body) r.write(body); r.end();
  });
  const jpost = (p, o, h) => req('POST', p, { 'Content-Type': 'application/json', ...(h || {}) }, JSON.stringify(o));
  const latestToken = (email) => database.db.prepare('SELECT token FROM login_tokens WHERE email = ? ORDER BY rowid DESC').get(email).token;
  const hexRun = /\b[0-9a-f]{32,}\b/i;
  const noCredentialInLogs = (token, extra = []) => {
    const L = logs();
    assert.ok(!L.includes(token), 'raw token found in logs');
    assert.ok(!L.includes('token=' + token), 'token query found in logs');
    assert.ok(!/\/api\/auth\/verify\?token=(?!\[REDACTED\])[^\s]/.test(L), 'unredacted verify URL found in logs');
    assert.ok(!hexRun.test(L), 'long hex string (token-like) found in logs');
    for (const x of extra) assert.ok(!L.includes(x), 'secret material found in logs');
  };

  if (mode === 'devnosecret') {
    await t('S1 dev without SESSION_SECRET: warning logged but NO secret material (no 16+ hex run)', async () => {
      const L = logs();
      assert.ok(/SESSION_SECRET non configurato in development/.test(L), 'warning missing');
      assert.ok(!/[0-9a-f]{16}/i.test(L), 'hex secret fragment logged');
    });
  } else if (mode === 'mock') {
    const email = 'mock.user@example.test';
    await t('M1 configured provider (stub): email IS sent with the working link (function preserved)', async () => {
      const r = await jpost('/api/auth/request-magic-link', { email });
      assert.strictEqual(r.status, 200);
      const tok = latestToken(email);
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].to, email);
      assert.ok(sent[0].text.includes(`/api/auth/verify?token=${tok}`), 'email lacks working link');
      noCredentialInLogs(tok);
      assert.ok(!r.text.includes(tok), 'token in HTTP response');
    });
    await t('M2 provider failure that echoes the email body: error logged REDACTED, response still generic', async () => {
      failNext = true;
      const r = await jpost('/api/auth/request-magic-link', { email });
      failNext = false;
      const tok = latestToken(email);
      assert.strictEqual(r.status, 200);
      assert.ok(/Errore invio email tramite Resend/.test(logs()), 'error not logged at all');
      assert.ok(/\[REDACTED\]/.test(logs()), 'no redaction marker');
      noCredentialInLogs(tok);
      assert.ok(!r.text.includes(tok));
    });
  } else {
    const email = 'Dev.User@Example.test';
    const lower = email.toLowerCase();
    let token, cookieVal;
    await t('T1/T2/T4/T5 request link (Resend missing): token, token URL and long-hex strings absent from ALL output', async () => {
      const r = await jpost('/api/auth/request-magic-link', { email });
      assert.strictEqual(r.status, 200);
      token = latestToken(lower);
      noCredentialInLogs(token);
    });
    await t('T3 safe informational log remains understandable (masked email, redacted hint, no full email)', async () => {
      const L = logs();
      assert.ok(/Magic-link generato per d\*\*\*@example\.test/.test(L), 'masked-email line missing');
      assert.ok(/invio saltato/.test(L) && /\/api\/auth\/verify\?token=\[REDACTED\]/.test(L), 'redacted hint missing');
      assert.ok(!L.includes(lower), 'full email in logs');
    });
    await t('T6/D response is generic (same for invalid email), and carries no token/link', async () => {
      const a = await jpost('/api/auth/request-magic-link', { email });
      const b = await jpost('/api/auth/request-magic-link', { email: 'not-an-email' });
      assert.strictEqual(a.status, 200); assert.strictEqual(b.status, 200);
      assert.strictEqual(a.json.message, b.json.message);
      const tok = latestToken(lower);
      assert.ok(!a.text.includes(tok) && !/verify|token/i.test(a.text), 'response leaks token/link');
      assert.ok(!JSON.stringify(a.headers).includes(tok), 'header leaks token');
      token = tok; // most recent valid token
    });
    await t('T7/T10 token verifies once -> 302 /?login=success, cookie HttpOnly+SameSite=Lax' + (prod ? '+Secure' : ''), async () => {
      const r = await req('GET', '/api/auth/verify?token=' + token);
      const sc = (r.headers['set-cookie'] || []).join(';');
      assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.location, '/?login=success');
      assert.ok(/ie_session=/.test(sc) && /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc), 'cookie flags');
      if (prod) assert.ok(/Secure/i.test(sc), 'Secure flag missing in production');
      cookieVal = (sc.match(/ie_session=([^;]+)/) || [])[1];
      assert.ok(cookieVal && cookieVal.split('.').length === 3, 'no JWT cookie');
    });
    await t('T8 same token cannot be reused', async () => {
      const r = await req('GET', '/api/auth/verify?token=' + token);
      assert.strictEqual(r.headers.location, '/?login=expired');
    });
    await t('T9 expired token rejected', async () => {
      const tok = 'ab'.repeat(32);
      database.insertLoginToken({ token: tok, email: lower, anon_user_id: null, expires_at: Date.now() - 1000 });
      const r = await req('GET', '/api/auth/verify?token=' + tok);
      assert.strictEqual(r.headers.location, '/?login=expired');
    });
    await t('T12 TEST_MODE accepts the valid session (extraction 200)', async () => {
      const b = '----B' + Math.random().toString(16).slice(2);
      const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="invoices"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`), Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`\r\n--${b}--\r\n`)]);
      const r = await req('POST', '/api/extract', { Cookie: 'ie_session=' + cookieVal, 'Content-Type': 'multipart/form-data; boundary=' + b }, body);
      assert.strictEqual(r.status, 200, r.text);
    });
    await t('T13 X-User-Id alone is NOT authenticated in TEST_MODE (401 TEST_MODE_AUTH_REQUIRED)', async () => {
      const r = await jpost('/api/extract', {}, { 'X-User-Id': 'usr_abcdefgh-1234' });
      assert.strictEqual(r.status, 401); assert.strictEqual(r.json.code, 'TEST_MODE_AUTH_REQUIRED');
    });
    await t('T11 logout clears the cookie', async () => {
      const r = await jpost('/api/auth/logout', {}, { Cookie: 'ie_session=' + cookieVal });
      assert.strictEqual(r.status, 200); assert.ok(/ie_session=;/.test((r.headers['set-cookie'] || []).join(';')));
    });
    await t('Z session JWT, SESSION_SECRET and all tokens absent from logs after the full flow', async () => {
      assert.ok(!logs().includes(cookieVal), 'session JWT in logs');
      const dec = jwt.decode(cookieVal);
      assert.ok(dec && dec.userId);
      noCredentialInLogs(token, ['auth-log-test-secret']);
      if (prod) assert.ok(!/\n\s+at\s+\S+.*:\d+:\d+/.test(logs()), 'stack frames in production logs');
    });
  }

  await t('T14/T15 zero outbound network attempts (Resend/Anthropic/Stripe/any)', async () => { assert.deepStrictEqual(outbound, []); });
  try { database.db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(fail ? 1 : 0);
}

const mode = process.argv[2];
if (!mode) parent();
else child(mode).catch((e) => { fs.writeSync(1, 'FAIL: child crashed ' + e.message + '\n'); process.exit(1); });
