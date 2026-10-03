#!/usr/bin/env node
/**
 * Express trust-proxy / rate-limit regression test (offline).
 *
 * Local simulation of ONE trusted proxy hop: the test client connects from
 * 127.0.0.1 and plays the role of the load balancer, sending X-Forwarded-For
 * (and X-Forwarded-Proto) like Render does. This verifies Express/
 * express-rate-limit semantics only. It does NOT prove Render's real network
 * topology - that remains a documented deployment assumption.
 *
 * Isolated child scenarios (each: temp DB, provider credentials blanked,
 * outbound network blocked). Run: node test/proxy.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const cp = require('child_process');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const MODES = { limit: 34671, app: 34672, anon: 34673, prod: 34674, dev: 34675, hops: 34676 };
const HOPS_CASES = [['', 1], ['1', 1], ['0', 0], ['2', 2], ['true', 1], ['abc', 1], ['-1', 1], ['9', 1], ['1.5', 1]];

function parent() {
  let pass = 0, fail = 0;
  const run = (mode, env, label) => {
    const r = cp.spawnSync(process.execPath, [__filename, mode], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
    const lines = (r.stdout || '').split(/\r?\n/).filter((l) => /^(PASS|FAIL): /.test(l));
    lines.forEach((l) => { console.log(`[${label || mode}] ${l}`); l.startsWith('PASS') ? pass++ : fail++; });
    if (r.status !== 0 || lines.length === 0) { console.log(`FAIL: [${label || mode}] child exited ${r.status} ${(r.stderr || '').slice(0, 300)}`); fail++; }
  };
  ['limit', 'app', 'anon', 'prod', 'dev'].forEach((m) => run(m, { TRUST_PROXY_HOPS: '' }));
  for (const [raw, expected] of HOPS_CASES) run('hops', { TRUST_PROXY_HOPS: raw, EXPECT_HOPS: String(expected) }, `hops=${JSON.stringify(raw)}`);
  console.log(`\nPASS: ${pass}  FAIL: ${fail}  TOTAL: ${pass + fail}`);
  process.exit(fail ? 1 : 0);
}

async function child(mode) {
  const PORT = MODES[mode];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-test-'));
  const hopsRaw = process.env.TRUST_PROXY_HOPS;
  Object.assign(process.env, {
    TEST_DB_PATH: path.join(tmpDir, 'p.sqlite'), PORT: String(PORT), FRONTEND_URL: `http://127.0.0.1:${PORT}`,
    NODE_ENV: mode === 'prod' ? 'production' : 'development', LAUNCH_MODE: 'waitlist',
    TEST_MODE: mode === 'anon' || mode === 'dev' || mode === 'prod' ? 'false' : 'true', TEST_DAILY_EXTRACTION_LIMIT: '1000',
    RATE_LIMIT_MAX_REQUESTS: mode === 'limit' ? '3' : '100000',
    SESSION_SECRET: 'proxy-test-secret-proxy-test-secret-123456',
    ANTHROPIC_API_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', RESEND_API_KEY: '',
  });
  if (mode !== 'hops') process.env.TRUST_PROXY_HOPS = ''; else process.env.TRUST_PROXY_HOPS = hopsRaw;
  if (mode !== 'hops') delete process.env.TRUST_PROXY_HOPS;

  const captured = [];
  for (const k of ['log', 'info', 'warn', 'error']) console[k] = (...a) => captured.push(a.map(String).join(' '));
  process.stdout.write = () => true; process.stderr.write = () => true;
  const out = (s) => fs.writeSync(1, s + '\n');

  const outbound = [];
  const of = global.fetch;
  global.fetch = (u, ...a) => { if (!/^(https?:\/\/)?(127\.0\.0\.1|localhost)/.test(String(u && u.url ? u.url : u))) { outbound.push(String(u)); return Promise.reject(new Error('blocked')); } return of(u, ...a); };
  for (const m of ['request', 'get']) https[m] = () => { outbound.push('https.' + m); throw new Error('blocked'); };

  const csPath = require.resolve(path.join(ROOT, 'src/services/claudeService'));
  require.cache[csPath] = { id: csPath, filename: csPath, loaded: true, exports: { extractInvoiceData: async (b, m, fn) => ({ records: [{ supplier: 'S', subtotal: 1, vat_amount: 0, total: 1, currency: 'EUR', math_verified: true, source_file: fn }], truncated: false, extractedCount: 1 }) } };

  const app = require(path.join(ROOT, 'src/server.js'));
  const database = require(path.join(ROOT, 'src/services/database'));
  const authService = require(path.join(ROOT, 'src/services/authService'));
  const express = require(path.join(ROOT, 'node_modules/express'));
  const jwt = require(path.join(ROOT, 'node_modules/jsonwebtoken'));

  // Probe app sharing the REAL app's exact trust-proxy setting.
  const makeProbe = (trust) => { const p = express(); p.set('trust proxy', trust); p.get('/', (q, r) => r.json({ ip: q.ip, secure: q.secure, protocol: q.protocol })); return p; };
  const probePort = PORT + 100;
  const servers = [];
  const startProbe = (trust, port) => new Promise((r) => { const s = makeProbe(trust).listen(port, () => r(s)); servers.push(s); });
  await new Promise((r) => setTimeout(r, 300));

  const req = (port, method, p, headers, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(headers || {}), ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c));
      res.on('end', () => { const text = Buffer.concat(ch).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (e) { /* */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    }); r.on('error', reject); if (body) r.write(body); r.end();
  });
  const get = (p, h, port = PORT) => req(port, 'GET', p, h);
  const xff = (v, extra) => ({ 'X-Forwarded-For': v, ...(extra || {}) });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('p')]);
  const upload = (headers) => {
    const b = '----P' + Math.random().toString(16).slice(2);
    const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="invoices"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${b}--\r\n`)]);
    return req(PORT, 'POST', '/api/extract', { ...headers, 'Content-Type': 'multipart/form-data; boundary=' + b }, body);
  };
  const cookieFor = (uid) => 'ie_session=' + jwt.sign({ userId: uid, email: uid + '@x.test' }, process.env.SESSION_SECRET, { expiresIn: '1h' });

  let pass = 0, fail = 0;
  const t = async (name, fn) => { try { await fn(); out('PASS: ' + name); pass++; } catch (e) { out('FAIL: ' + name + ' :: ' + e.message); fail++; } };
  const A = '203.0.113.10', B = '203.0.113.20';
  const trust = app.get('trust proxy');

  if (mode === 'hops') {
    const expected = Number(process.env.EXPECT_HOPS);
    await t(`trust proxy resolves to exactly ${expected} for TRUST_PROXY_HOPS=${JSON.stringify(hopsRaw)} (never "true")`, async () => {
      assert.strictEqual(trust === 0 ? false : trust, expected === 0 ? false : expected);
      assert.notStrictEqual(trust, true);
      if (expected === 1 && hopsRaw !== '' && hopsRaw !== '1') assert.ok(captured.some((l) => /TRUST_PROXY_HOPS non valido/.test(l)), 'no warning for invalid value');
    });
  } else if (mode === 'limit') {
    await t('T1 no forwarded header: direct local request behaves normally (200, req.ip = socket)', async () => {
      const s = await startProbe(trust, probePort); const r = await get('/', {}, probePort);
      assert.ok(/127\.0\.0\.1|::1/.test(r.json.ip), r.json.ip); assert.strictEqual((await get('/api/health')).status, 200);
    });
    await t('T6c trust proxy is exactly 1 hop: not true, not a function, not unlimited', async () => {
      assert.strictEqual(trust, 1);
    });
    await t('T2/T3 via trusted hop: client A and client B resolve to distinct req.ip', async () => {
      const a = await get('/', xff(A), probePort), b = await get('/', xff(B), probePort);
      assert.strictEqual(a.json.ip, A); assert.strictEqual(b.json.ip, B); assert.notStrictEqual(a.json.ip, b.json.ip);
    });
    await t('T4/T5 global limiter (max 3): A exhausts ITS bucket; B keeps its own full allowance', async () => {
      const a = []; for (let i = 0; i < 4; i++) a.push((await get('/api/health', xff(A))).status);
      assert.deepStrictEqual(a, [200, 200, 200, 429], 'A: ' + a);
      const b = []; for (let i = 0; i < 4; i++) b.push((await get('/api/health', xff(B))).status);
      assert.deepStrictEqual(b, [200, 200, 200, 429], 'B: ' + b);
    });
    await t('T6 multi-hop chain: attacker-controlled LEFT entries are ignored (req.ip = rightmost, trusted-hop entry)', async () => {
      const c1 = await get('/', xff('1.1.1.1, 2.2.2.2, 203.0.113.30'), probePort);
      const c2 = await get('/', xff('9.9.9.9, 203.0.113.30'), probePort);
      assert.strictEqual(c1.json.ip, '203.0.113.30'); assert.strictEqual(c2.json.ip, '203.0.113.30');
    });
    await t('T6b rotating forged left-prefixes cannot mint fresh rate-limit buckets', async () => {
      const s = []; for (const p of ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4']) s.push((await get('/api/health', xff(`${p}, 203.0.113.30`))).status);
      assert.deepStrictEqual(s, [200, 200, 200, 429], 'statuses ' + s);
    });
    await t('T6d control: with trust proxy=true the LEFT entry WOULD be accepted (why "true" is not used)', async () => {
      const s = await startProbe(true, probePort + 1); const r = await get('/', xff('1.1.1.1, 203.0.113.30'), probePort + 1);
      assert.strictEqual(r.json.ip, '1.1.1.1');
    });
    await t('T6e malformed X-Forwarded-For does not crash the server', async () => {
      const r = await get('/api/health', xff('not an ip ,,, ;;;')); assert.ok([200, 429].includes(r.status), 'status ' + r.status);
      assert.strictEqual((await get('/api/health', xff('203.0.113.77'))).status, 200, 'server unhealthy after malformed header');
    });
  } else if (mode === 'app') {
    await t('T7a TEST_MODE: extraction limiter keyed by authenticated USER, not IP (3/min holds across rotating client IPs)', async () => {
      const c = cookieFor('usr_proxyuser-0001'); const s = [];
      for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4']) s.push((await upload({ Cookie: c, ...xff(ip) })).status);
      assert.deepStrictEqual(s, [200, 200, 200, 429], 'statuses ' + s);
    });
    await t('T7b burst 429 is the extraction-limiter message (distinct from daily quota) and daily quota not consumed by it', async () => {
      const c = cookieFor('usr_proxyuser-0002'); let last;
      for (let i = 0; i < 4; i++) last = await upload({ Cookie: c, ...xff('198.51.100.9') });
      assert.strictEqual(last.status, 429); assert.ok(/Troppe richieste di estrazione/.test(last.json.error)); assert.ok(!last.json.code);
      assert.strictEqual(database.getTestUsage('usr_proxyuser-0002', new Date().toISOString().split('T')[0]), 3);
    });
    await t('T7c a different user behind the SAME client IP keeps an independent allowance', async () => {
      const r = await upload({ Cookie: cookieFor('usr_proxyuser-0003'), ...xff('198.51.100.1') }); assert.strictEqual(r.status, 200);
    });
    await t('T7d TEST_MODE still rejects X-User-Id-only (401) regardless of forwarded IP', async () => {
      const r = await upload({ 'X-User-Id': 'usr_abcdefgh-1234', ...xff('198.51.100.1') });
      assert.strictEqual(r.status, 401); assert.strictEqual(r.json.code, 'TEST_MODE_AUTH_REQUIRED');
    });
  } else if (mode === 'anon') {
    const jpost = (headers) => req(PORT, 'POST', '/api/extract', { 'Content-Type': 'application/json', ...headers }, '{}');
    await t('anonymous (no identity) extraction limiter is now per real client IP: A limited, B independent', async () => {
      const a = []; for (let i = 0; i < 4; i++) a.push((await jpost(xff(A))).status);
      assert.deepStrictEqual(a, [400, 400, 400, 429], 'A ' + a);
      assert.strictEqual((await jpost(xff(B))).status, 400);
    });
    await t('X-User-Id keyed limiter unchanged (key = user id, shared across IPs)', async () => {
      const h = { 'X-User-Id': 'usr_headeruser-0001' }; const s = [];
      for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4']) s.push((await jpost({ ...h, ...xff(ip) })).status);
      assert.deepStrictEqual(s, [400, 400, 400, 429], 's ' + s);
    });
  } else if (mode === 'prod') {
    const verify = async (headers) => { const tok = authService.generateLoginToken('p' + Math.random().toString(16).slice(2, 8) + '@example.test'); return get('/api/auth/verify?token=' + tok, headers); };
    await t('T8 production + forwarded HTTPS: probe sees req.secure=true, protocol=https', async () => {
      await startProbe(trust, probePort); const r = await get('/', xff(A, { 'X-Forwarded-Proto': 'https' }), probePort);
      assert.strictEqual(r.json.secure, true); assert.strictEqual(r.json.protocol, 'https');
    });
    await t('T8 production + forwarded HTTPS: session cookie is HttpOnly + Secure + SameSite=Lax', async () => {
      const r = await verify(xff(A, { 'X-Forwarded-Proto': 'https' })); const sc = (r.headers['set-cookie'] || []).join(';');
      assert.strictEqual(r.status, 302); assert.ok(/HttpOnly/i.test(sc) && /Secure/i.test(sc) && /SameSite=Lax/i.test(sc), sc.replace(/ie_session=[^;]+/, 'ie_session=<jwt>'));
    });
    await t('T8b Secure flag is NODE_ENV-driven (not req.secure): still set without proxy headers (documented, unchanged)', async () => {
      const sc = ((await verify({})).headers['set-cookie'] || []).join(';'); assert.ok(/Secure/i.test(sc));
    });
  } else if (mode === 'dev') {
    await t('T9 development over plain HTTP, no proxy headers: app usable, cookie NOT Secure (login works on localhost)', async () => {
      assert.strictEqual((await get('/api/health')).status, 200);
      const tok = authService.generateLoginToken('dev@example.test');
      const r = await get('/api/auth/verify?token=' + tok); const sc = (r.headers['set-cookie'] || []).join(';');
      assert.strictEqual(r.status, 302); assert.ok(/HttpOnly/i.test(sc) && !/Secure/i.test(sc));
    });
  }

  await t('zero outbound network attempts (Anthropic/Stripe/Resend/any)', async () => { assert.deepStrictEqual(outbound, []); });
  servers.forEach((s) => s.close());
  try { database.db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(fail ? 1 : 0);
}

const mode = process.argv[2];
if (!mode) parent();
else child(mode).catch((e) => { fs.writeSync(1, 'FAIL: child crashed ' + e.message + '\n'); process.exit(1); });
