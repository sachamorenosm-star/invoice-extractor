// Scanner, allowlist, delivery, sessions and atomic single-use: all offline.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const cp = require('child_process');
const vm = require('vm');
require('./helpers/offline');
const mode = process.argv[2];
const out = (message) => fs.writeSync(1, message + '\n');
const root = path.join(__dirname, '..');

if (!mode) {
  let pass = 0, fail = 0;
  for (const scenario of ['mock', 'missing', 'empty', 'malformed', 'unconfigured']) {
    const result = cp.spawnSync(process.execPath, [__filename, scenario], { cwd: root, encoding: 'utf8', timeout: 30000 });
    const lines = (result.stdout || '').split(/\r?\n/).filter((line) => /^(PASS|FAIL): [^0-9]/.test(line));
    for (const line of lines) { out(`[${scenario}] ${line}`); line.startsWith('PASS:') ? pass++ : fail++; }
    if (result.status !== 0 || !lines.length) { fail++; out('FAIL: child scenario ' + scenario + ' failed'); }
  }
  out(`PASS: ${pass}  FAIL: ${fail}  SKIPPED: 0  TOTAL: ${pass + fail}`);
  process.exit(fail ? 1 : 0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'private-beta-auth-'));
const port = 34742;
const allowed = 'tester@example.test,existing@example.test,new@example.test,failure@example.test,resolved@example.test,rate@example.test,concurrent@example.test';
Object.assign(process.env, {
  NODE_ENV: 'production', TEST_MODE: 'true', TEST_GLOBAL_DAILY_EXTRACTION_LIMIT: '500', PORT: String(port),
  FRONTEND_URL: `http://127.0.0.1:${port}`, TEST_DB_PATH: path.join(tmp, 'auth.sqlite'),
  SESSION_SECRET: 'private-beta-synthetic-session-secret-32-plus',
  RESEND_API_KEY: mode === 'unconfigured' ? '' : 're_synthetic_mock_only_key',
  BETA_ALLOWED_EMAILS: allowed, RATE_LIMIT_MAX_REQUESTS: '100000',
});
if (mode === 'missing') delete process.env.BETA_ALLOWED_EMAILS;
if (mode === 'empty') process.env.BETA_ALLOWED_EMAILS = ' , , ';
if (mode === 'malformed') process.env.BETA_ALLOWED_EMAILS = 'not-an-email';

const captured = [];
for (const method of ['log', 'info', 'warn', 'error']) console[method] = (...args) => captured.push(args.map(String).join(' '));
process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
const sent = [];
let deliveryMode = 'success';
const resendPath = require.resolve('resend');
class Resend {
  constructor() {
    this.emails = { send: async (payload) => {
      sent.push(payload);
      const detail = 'provider-private-body ' + payload.text + ' ' + process.env.RESEND_API_KEY;
      if (deliveryMode === 'throw') throw new Error(detail);
      if (deliveryMode === 'error') return { data: null, error: { message: detail } };
      if (deliveryMode === 'empty') return {};
      return { data: { id: 'synthetic-email-id' }, error: null };
    } };
  }
}
require.cache[resendPath] = { id: resendPath, filename: resendPath, loaded: true, exports: { Resend } };
const providerPath = require.resolve('../src/services/claudeService');
require.cache[providerPath] = { id: providerPath, filename: providerPath, loaded: true, exports: { extractInvoiceData: async () => { throw new Error('IA must not be called by auth tests'); } } };
require('../src/server');
const auth = require('../src/services/authService');
const database = require('../src/services/database');
const { getBetaAllowedEmails } = require('../src/utils/betaAccess');
const jwt = require('jsonwebtoken');
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; out('PASS: ' + name); }
  catch (error) { fail++; out('FAIL: ' + name + ' :: ' + error.message); }
}
function request(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject); req.end(body);
  });
}
const post = (route, body, headers = {}) => request('POST', route, JSON.stringify(body), { 'Content-Type': 'application/json', ...headers });
const issue = (email) => post('/api/auth/request-magic-link', { email });
const confirm = (token, headers) => post('/api/auth/verify', { token }, headers);
const tokenRow = (email) => database.db.prepare('SELECT * FROM login_tokens WHERE email = ? ORDER BY rowid DESC').get(email);
const tokens = new Set();
const newToken = (email = 'tester@example.test') => { const token = auth.generateLoginToken(email); tokens.add(token); return token; };
const tokenCount = () => database.db.prepare('SELECT count(*) AS n FROM login_tokens').get().n;
const userCount = () => database.db.prepare('SELECT count(*) AS n FROM users').get().n;
const noSession = (result) => assert.ok(!result.headers['set-cookie'], 'unexpected session cookie');
const assertConsumed = (token, expected) => assert.strictEqual(database.getLoginToken(token).used, expected);
async function passiveRequest(method, token) {
  const sign = jwt.sign;
  jwt.sign = () => { throw new Error('Passive request attempted to create a JWT'); };
  try { return await request(method, '/api/auth/verify?token=' + token); }
  finally { jwt.sign = sign; }
}

async function main() {
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (mode !== 'mock') {
    await test('production starts without opening beta access: ' + mode, async () => {
      const a = await issue('tester@example.test'); const b = await issue('outsider@example.test');
      assert.strictEqual(a.status, mode === 'unconfigured' ? 503 : 200);
      assert.strictEqual(a.status, b.status); assert.deepStrictEqual(a.json, b.json);
      assert.strictEqual(tokenCount(), 0); assert.strictEqual(sent.length, 0);
      noSession(a); noSession(b);
      if (mode !== 'unconfigured') assert.strictEqual(getBetaAllowedEmails().size, 0);
    });
    await test('production fail-closed configuration has no usable historical token: ' + mode, async () => {
      if (mode === 'unconfigured') return assert.ok(captured.join('\n').includes('login_delivery_unavailable'));
      const token = crypto.randomBytes(32).toString('hex'); tokens.add(token);
      database.insertLoginToken({ token, email: 'tester@example.test', expires_at: Date.now() + 900000 });
      noSession(await request('HEAD', '/api/auth/verify?token=' + token));
      const result = await confirm(token); noSession(result);
      assert.strictEqual(result.headers.location, '/?login=expired'); assertConsumed(token, 0);
    });
  } else {
    let issuedToken, sessionCookie;
    await test('allowed beta email creates and sends a normalized 256-bit 15-minute token', async () => {
      const before = Date.now(); const result = await issue(' Tester@Example.test ');
      assert.strictEqual(result.status, 200); noSession(result);
      const row = tokenRow('tester@example.test'); issuedToken = row.token; tokens.add(issuedToken);
      assert.match(row.token, /^[0-9a-f]{64}$/); assert.strictEqual(row.used, 0);
      assert.ok(row.expires_at >= before + 900000 && row.expires_at <= Date.now() + 900000);
      assert.strictEqual(sent[0].to, 'tester@example.test'); assert.ok(sent[0].text.includes('/api/auth/verify?token=' + row.token));
    });
    await test('non-invited and invalid email get same generic public response without any token/send', async () => {
      const before = tokenCount(), sends = sent.length;
      const allowedResponse = await issue('tester@example.test');
      const denied = await issue('outsider@example.test'); const invalid = await issue('not-an-email');
      assert.strictEqual(denied.status, 200); assert.deepStrictEqual(denied.json, allowedResponse.json); assert.deepStrictEqual(invalid.json, denied.json);
      assert.strictEqual(tokenCount(), before + 1); assert.strictEqual(sent.length, sends + 1);
      assert.ok(!tokenRow('outsider@example.test'));
    });
    await test('allowlist normalization trims and lowercases consistently', async () => {
      process.env.BETA_ALLOWED_EMAILS = ' Tester@Example.Test , , EXISTING@example.test';
      try { assert.ok(getBetaAllowedEmails().has('tester@example.test')); assert.strictEqual(getBetaAllowedEmails().size, 2); assert.ok(newToken(' Tester@Example.Test ')); }
      finally { process.env.BETA_ALLOWED_EMAILS = allowed; }
    });
    await test('GET shows confirmation and does not consume token or create an account/session', async () => {
      const before = userCount(); const result = await passiveRequest('GET', issuedToken);
      assert.strictEqual(result.status, 200); assertConsumed(issuedToken, 0); noSession(result); assert.strictEqual(userCount(), before);
      assert.match(result.text, /Conferma accesso a InvoiceExtract/); assert.match(result.text, /method="post" action="\/api\/auth\/verify"/);
      assert.match(result.text, /type="hidden" name="token"/); assert.match(result.text, />Accedi<\/button>/);
      assert.ok(!result.text.includes('<script') && !result.text.includes('tester@example.test'));
      assert.ok(!result.text.replace(/<input[^>]*>/g, '').includes(issuedToken));
      assert.strictEqual(result.headers['cache-control'], 'no-store'); assert.strictEqual(result.headers['referrer-policy'], 'no-referrer');
    });
    await test('HEAD does not consume token, create account/JWT or set cookie', async () => {
      const before = userCount(); const result = await passiveRequest('HEAD', issuedToken);
      assert.strictEqual(result.status, 200); assert.strictEqual(result.text, ''); noSession(result);
      assertConsumed(issuedToken, 0); assert.strictEqual(userCount(), before);
    });
    await test('repeated and prefetch GETs leave token usable', async () => {
      for (let i = 0; i < 3; i++) noSession(await request('GET', '/api/auth/verify?token=' + issuedToken, undefined, { Purpose: 'prefetch' }));
      assertConsumed(issuedToken, 0);
    });
    await test('GET -> HEAD -> form POST succeeds once and consumes token', async () => {
      const body = new URLSearchParams({ token: issuedToken }).toString();
      const result = await request('POST', '/api/auth/verify', body, { 'Content-Type': 'application/x-www-form-urlencoded', Origin: process.env.FRONTEND_URL });
      assert.strictEqual(result.status, 303); assert.strictEqual(result.headers.location, '/?login=success'); assertConsumed(issuedToken, 1);
      sessionCookie = result.headers['set-cookie'][0].split(';')[0];
      tokens.add(sessionCookie.split('=')[1]);
      const cookie = result.headers['set-cookie'].join(';');
      for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=2592000']) assert.ok(cookie.includes(flag), flag);
      const decoded = jwt.decode(sessionCookie.split('=')[1], { complete: true });
      assert.strictEqual(decoded.header.alg, 'HS256'); assert.strictEqual(decoded.payload.exp - decoded.payload.iat, 30 * 86400);
    });
    await test('second POST fails without another session', async () => {
      const result = await confirm(issuedToken); assert.strictEqual(result.status, 303); assert.strictEqual(result.headers.location, '/?login=expired'); noSession(result);
    });
    await test('expired token fails without being consumed', async () => {
      const token = crypto.randomBytes(32).toString('hex'); tokens.add(token);
      database.insertLoginToken({ token, email: 'tester@example.test', expires_at: Date.now() - 1 });
      noSession(await request('GET', '/api/auth/verify?token=' + token));
      const result = await confirm(token); assert.strictEqual(result.headers.location, '/?login=expired'); noSession(result); assertConsumed(token, 0);
    });
    await test('invalid/missing/array token and query-only POST never authenticate', async () => {
      for (const token of ['invalid', crypto.randomBytes(32).toString('hex'), undefined, ['ab'.repeat(32)]]) {
        const result = await confirm(token); assert.strictEqual(result.headers.location, '/?login=expired'); noSession(result);
      }
      const token = newToken(); const result = await post('/api/auth/verify?token=' + token, {});
      noSession(result); assertConsumed(token, 0); assert.strictEqual(result.headers.location, '/?login=expired');
    });
    await test('token removal from allowlist blocks existing credentials', async () => {
      const token = newToken(); process.env.BETA_ALLOWED_EMAILS = 'existing@example.test';
      try { const result = await confirm(token); noSession(result); assert.strictEqual(result.headers.location, '/?login=expired'); assertConsumed(token, 0); }
      finally { process.env.BETA_ALLOWED_EMAILS = allowed; }
    });
    await test('non-invited historical token cannot create a session', async () => {
      const token = crypto.randomBytes(32).toString('hex'); tokens.add(token);
      database.insertLoginToken({ token, email: 'outsider@example.test', expires_at: Date.now() + 900000 });
      assert.throws(() => auth.generateLoginToken('outsider@example.test'));
      const result = await confirm(token); noSession(result); assertConsumed(token, 0); assert.strictEqual(result.headers.location, '/?login=expired');
    });
    await test('concurrent HTTP confirmations issue exactly one session', async () => {
      const token = newToken(); const results = await Promise.all(Array.from({ length: 4 }, () => confirm(token)));
      assert.strictEqual(results.filter((result) => result.headers.location === '/?login=success').length, 1);
      assert.strictEqual(results.filter((result) => result.headers['set-cookie']).length, 1); assertConsumed(token, 1);
    });
    await test('separate SQLite processes atomically consume a token exactly once', async () => {
      const token = newToken('concurrent@example.test');
      const workers = Array.from({ length: 4 }, () => cp.fork(path.join(__dirname, 'helpers/consume-login-token.js'), [], { silent: true }));
      try {
        const ready = workers.map((worker) => new Promise((resolve, reject) => {
          worker.once('error', reject); worker.once('message', resolve);
          worker.stdout.on('data', (chunk) => captured.push(String(chunk))); worker.stderr.on('data', (chunk) => captured.push(String(chunk)));
        }));
        await Promise.all(ready);
        const results = workers.map((worker) => new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', resolve); worker.send({ token }); }));
        const consumed = await Promise.all(results); assert.strictEqual(consumed.filter((result) => result.consumed).length, 1); assertConsumed(token, 1);
      } finally { workers.forEach((worker) => worker.kill()); }
    });
    await test('known thrown delivery failure returns generic 503 without consuming token or creating a session', async () => {
      deliveryMode = 'throw';
      try {
        const result = await issue('failure@example.test'); const row = tokenRow('failure@example.test'); tokens.add(row.token);
        assert.strictEqual(result.status, 503); assert.deepStrictEqual(result.json, { error: 'Accesso temporaneamente non disponibile. Riprova tra poco.' });
        assert.strictEqual(row.used, 0); noSession(result);
        assert.ok(!result.text.includes('provider-private-body') && !result.text.includes(row.token));
      } finally { deliveryMode = 'success'; }
    });
    await test('resolved Resend error is treated as delivery failure with no provider body exposed', async () => {
      deliveryMode = 'error';
      try { const result = await issue('resolved@example.test'); const row = tokenRow('resolved@example.test'); tokens.add(row.token); assert.strictEqual(result.status, 503); assert.strictEqual(row.used, 0); assert.ok(!result.text.includes('provider-private-body')); }
      finally { deliveryMode = 'success'; }
    });
    await test('missing provider acknowledgement cannot falsely report delivery success', async () => {
      deliveryMode = 'empty';
      try { const result = await issue('failure@example.test'); assert.strictEqual(result.status, 503); assert.strictEqual(tokenRow('failure@example.test').used, 0); }
      finally { deliveryMode = 'success'; }
    });
    await test('existing and new accounts get identical public login responses', async () => {
      auth.findOrCreateUserForEmail('existing@example.test');
      const a = await issue('existing@example.test'); const b = await issue('new@example.test');
      assert.strictEqual(a.status, 200); assert.strictEqual(b.status, 200); assert.deepStrictEqual(a.json, b.json);
    });
    await test('normalized email limiter still blocks the fourth login request', async () => {
      const results = [];
      for (const email of ['rate@example.test', ' RATE@EXAMPLE.TEST ', 'Rate@Example.Test', 'rate@example.test']) results.push((await issue(email)).status);
      assert.deepStrictEqual(results, [200, 200, 200, 429]);
    });
    await test('post-login redirect ignores arbitrary external destinations', async () => {
      const token = newToken(); const page = await request('GET', '/api/auth/verify?token=' + token + '&next=https://outside.example.test');
      assert.ok(page.text.includes('action="/api/auth/verify"'));
      const result = await post('/api/auth/verify?redirect=https://outside.example.test', { token, next: 'https://outside.example.test' });
      assert.strictEqual(result.headers.location, '/?login=success');
    });
    await test('cross-site and prefetch POSTs cannot consume token', async () => {
      const token = newToken();
      for (const headers of [{ Origin: 'https://outside.example.test' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { Purpose: 'prefetch' }, { Purpose: 'prerender' }, { 'Sec-Purpose': 'prefetch;prerender' }]) {
        const result = await confirm(token, headers); assert.strictEqual(result.status, 403); noSession(result); assertConsumed(token, 0);
      }
      assert.strictEqual((await confirm(token)).headers.location, '/?login=success');
    });
    await test('other HTTP methods cannot consume token', async () => {
      const token = newToken();
      for (const method of ['OPTIONS', 'PUT', 'DELETE']) { noSession(await request(method, '/api/auth/verify?token=' + token)); assertConsumed(token, 0); }
    });
    await test('valid JWT session remains accepted', async () => {
      const result = await request('GET', '/api/auth/me', undefined, { Cookie: sessionCookie });
      assert.strictEqual(result.status, 200); assert.strictEqual(result.json.email, 'tester@example.test');
    });
    await test('JWT signed with wrong secret remains rejected', async () => {
      const token = jwt.sign({ userId: 'usr_invalid-user-12345', email: 'tester@example.test' }, 'wrong-synthetic-session-secret');
      assert.strictEqual((await request('GET', '/api/auth/me', undefined, { Cookie: 'ie_session=' + token })).status, 401);
    });
    await test('unsigned alg:none session remains rejected', async () => {
      const token = jwt.sign({ userId: 'usr_invalid-user-12345' }, null, { algorithm: 'none' });
      assert.strictEqual((await request('GET', '/api/auth/me', undefined, { Cookie: 'ie_session=' + token })).status, 401);
    });
    await test('expired and corrupted sessions remain rejected', async () => {
      for (const token of ['not-a-jwt', jwt.sign({ userId: 'usr_invalid-user-12345' }, process.env.SESSION_SECRET, { expiresIn: -1 })]) assert.strictEqual((await request('GET', '/api/auth/me', undefined, { Cookie: 'ie_session=' + token })).status, 401);
    });
    await test('logout still clears session cookie', async () => {
      const result = await post('/api/auth/logout', {}, { Cookie: sessionCookie });
      assert.strictEqual(result.status, 200); assert.match(result.headers['set-cookie'].join(';'), /ie_session=;/);
    });
    await test('normal-mode issuance remains independent of beta allowlist', async () => {
      process.env.TEST_MODE = 'false';
      try { const result = await issue('outside-normal@example.test'); assert.strictEqual(result.status, 200); assert.ok(tokenRow('outside-normal@example.test')); }
      finally { process.env.TEST_MODE = 'true'; }
    });
    await test('malformed auth request errors never log bearer credentials', async () => {
      const token = newToken(); const result = await request('POST', '/api/auth/verify?token=' + token, '{"token":"' + token + '",}', { 'Content-Type': 'application/json' });
      assert.strictEqual(result.status, 400); noSession(result); assertConsumed(token, 0); assert.ok(!result.text.includes(token));
    });
    await test('invalid GET/HEAD credential is neither reflected nor logged', async () => {
      for (const method of ['GET', 'HEAD']) { const result = await request(method, '/api/auth/verify?token=' + encodeURIComponent('"<script>private-marker</script>')); assert.strictEqual(result.headers.location, '/?login=expired'); noSession(result); }
    });
    await test('frontend 503 keeps login form available and never claims email sent', async () => {
      const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
      const start = source.indexOf("  els.loginForm?.addEventListener('submit'");
      const end = source.indexOf('  // Menu a tendina', start);
      const changes = [], notices = [];
      let callback;
      const classList = { add: (name) => changes.push('add:' + name), remove: (name) => changes.push('remove:' + name) };
      const elements = { loginForm: { addEventListener: (event, handler) => { callback = handler; }, classList }, loginEmailInput: { value: 'tester@example.test' }, loginSubmitBtn: {}, loginModalMessage: { classList } };
      const context = vm.createContext({ els: elements, getUserId: () => 'usr_test-12345678', fetch: async () => ({ ok: false, json: async () => ({ error: 'Accesso temporaneamente non disponibile. Riprova tra poco.' }) }), showToast: (text) => notices.push(text) });
      vm.runInContext(source.slice(start, end), context); await callback({ preventDefault() {} });
      assert.deepStrictEqual(changes, []); assert.ok(notices[0].includes('temporaneamente non disponibile')); assert.strictEqual(elements.loginSubmitBtn.disabled, false); assert.ok(!elements.loginModalMessage.textContent);
    });
  }
  await test('all magic-link tokens, JWTs, keys, email bodies and verification URLs absent from captured logs', () => {
    const logs = captured.join('\n');
    for (const row of database.db.prepare('SELECT token FROM login_tokens').all()) tokens.add(row.token);
    for (const token of tokens) assert.ok(!logs.includes(token), 'credential found in log');
    for (const marker of [process.env.SESSION_SECRET, 're_synthetic_mock_only_key', 'provider-private-body', 'tester@example.test', '/api/auth/verify?token=', 'private-marker']) assert.ok(!logs.includes(marker), 'private marker found in log');
    if (mode === 'mock') assert.ok(logs.includes('login_delivery_failed'));
  });
  database.db.close(); fs.rmSync(tmp, { recursive: true, force: true });
  out(`PASS: ${pass}  FAIL: ${fail}  SKIPPED: 0  TOTAL: ${pass + fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch(() => { out('FAIL: fatal auth test error'); process.exit(1); });
