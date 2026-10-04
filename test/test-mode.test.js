#!/usr/bin/env node
/**
 * Focused regression test for TEST_MODE atomic quota reservation
 * (fix for the TOCTOU race confirmed by independent audit of a37ff5c).
 *
 * - No live Anthropic/Stripe/Resend calls: claudeService.extractInvoiceData
 *   is stubbed in the module cache before the app is required.
 * - Uses a fully isolated, temporary SQLite database (TEST_DB_PATH env var,
 *   supported by src/services/database.js) — the real project database is
 *   never opened, modified, or touched by this file.
 * - Runs the REAL Express app (src/server.js) on a local test port, with
 *   real HTTP + real multipart/form-data requests, so the exact production
 *   middleware chain and route handler are exercised end to end.
 *
 * Run: node test/test-mode.test.js
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PROJECT_ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------
// 1. Isolated temp database (created fresh, deleted at the end).
// ---------------------------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-extractor-test-'));
const TEST_DB_PATH = path.join(tmpDir, 'test-mode-isolated.sqlite');

process.env.TEST_DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'test';
process.env.LAUNCH_MODE = 'waitlist';
process.env.SESSION_SECRET = 'test-only-session-secret-32-characters-minimum-xx';
process.env.PORT = '34589';
process.env.TEST_MODE = 'true';
process.env.TEST_DAILY_EXTRACTION_LIMIT = '50';
process.env.TEST_GLOBAL_DAILY_EXTRACTION_LIMIT = '500'; // Isolated regression ceiling, not a production recommendation.
// Stripe/Resend/Anthropic keys intentionally left unset: no live calls are
// possible even if something unexpected tried to reach them.

console.log('=== Test database isolation ===');
console.log('TEST_DB_PATH (isolated, temporary):', TEST_DB_PATH);
console.log('Real project DB (data/invoice-extractor.sqlite) is never opened by this run.\n');

// ---------------------------------------------------------------------
// 2. Stub claudeService BEFORE anything requires it, so zero live
//    Anthropic calls are possible even by accident.
// ---------------------------------------------------------------------
const claudeServicePath = require.resolve(path.join(PROJECT_ROOT, 'src/services/claudeService'));
let mockCallCount = 0;
const failFilenames = new Set();
const mockDelayMs = { value: 0 };

function makeMockRecord() {
  return {
    source_file: 'mock',
    supplier: 'Mock Supplier',
    invoice_number: 'MOCK-1',
    date: '2026-01-01',
    subtotal: 100,
    vat_amount: 22,
    total: 122,
    currency: 'EUR',
    math_verified: true,
  };
}

require.cache[claudeServicePath] = {
  id: claudeServicePath,
  filename: claudeServicePath,
  loaded: true,
  exports: {
    extractInvoiceData: async (buffer, mimetype, filename) => {
      mockCallCount++;
      if (mockDelayMs.value > 0) {
        await new Promise((r) => setTimeout(r, mockDelayMs.value));
      }
      if (failFilenames.has(filename)) {
        throw new Error('mocked extraction failure for ' + filename);
      }
      return { records: [makeMockRecord()], truncated: false, extractedCount: 1 };
    },
  },
};

// ---------------------------------------------------------------------
// 3. Boot the real app and import the real service/database modules
//    (now pointed at the isolated DB via TEST_DB_PATH).
// ---------------------------------------------------------------------
require(path.join(PROJECT_ROOT, 'src/server.js'));
const database = require(path.join(PROJECT_ROOT, 'src/services/database'));
const stripeService = require(path.join(PROJECT_ROOT, 'src/services/stripeService'));
const jwt = require('jsonwebtoken');
const { PDFDocument } = require('pdf-lib');

const PORT = 34589;

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function todayKey() {
  return new Date().toISOString().split('T')[0];
}

let userCounter = 0;
function newUserId() {
  userCounter++;
  return 'usr_' + 'test0000-0000-0000-0000-' + String(userCounter).padStart(12, '0');
}

function sessionCookieFor(userId) {
  const token = jwt.sign({ userId, email: userId + '@example.test' }, process.env.SESSION_SECRET, { expiresIn: '30d' });
  return 'ie_session=' + token;
}

async function makePdfBuffer(pageCount) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage();
  return Buffer.from(await doc.save());
}

function buildMultipart(files) {
  const boundary = '----TestBoundary' + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const f of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="invoices"; filename="${f.filename}"\r\n` +
      `Content-Type: ${f.mimetype}\r\n\r\n`,
    ));
    chunks.push(f.buffer);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), boundary };
}

function postExtract(headers, files) {
  return new Promise((resolve, reject) => {
    const { body, boundary } = buildMultipart(files || []);
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/extract',
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = { raw: data }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let pass = 0, fail = 0;
const results = [];
async function test(name, fn) {
  // Reset shared env state before every test so one test's failure can
  // never leak TEST_MODE/limit changes into the next test.
  process.env.TEST_MODE = 'true';
  process.env.TEST_DAILY_EXTRACTION_LIMIT = '50';
  try {
    await fn();
    console.log('PASS: ' + name);
    results.push({ name, status: 'PASS' });
    pass++;
  } catch (e) {
    console.log('FAIL: ' + name + '\n  ' + e.message);
    results.push({ name, status: 'FAIL', error: e.message });
    fail++;
  } finally {
    process.env.TEST_MODE = 'true';
    process.env.TEST_DAILY_EXTRACTION_LIMIT = '50';
  }
}

const assert = require('assert');

// ---------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------
async function main() {
  // Give the server a moment to start listening.
  await new Promise((r) => setTimeout(r, 300));

  await test('T1: atomic boundary -- used=45, request=5, limit=50 -> reservation succeeds, used=50', async () => {
    process.env.TEST_MODE = 'true';
    process.env.TEST_DAILY_EXTRACTION_LIMIT = '50';
    const userId = newUserId();
    const dk = todayKey();
    database.incrementTestUsage(userId, dk, 45);

    const ok = stripeService.reserveTestDailyQuota(userId, 5);
    assert.strictEqual(ok, true, 'reservation of 5 at used=45,limit=50 must succeed');
    assert.strictEqual(database.getTestUsage(userId, dk), 50, 'used must become exactly 50');
  });

  await test('T2: atomic rejection -- used=45, request=10 -> rejected, used stays 45, mock not called', async () => {
    const userId = newUserId();
    const dk = todayKey();
    database.incrementTestUsage(userId, dk, 45);
    const before = mockCallCount;

    const ok = stripeService.reserveTestDailyQuota(userId, 10);
    assert.strictEqual(ok, false, 'reservation of 10 at used=45,limit=50 must be rejected (55>50)');
    assert.strictEqual(database.getTestUsage(userId, dk), 45, 'used must remain 45');
    assert.strictEqual(mockCallCount, before, 'mock extraction must not have been called');
  });

  await test('T3: concurrent quota protection -- used=45, two competing 5-page HTTP requests -> exactly one succeeds, final=50, mock called exactly once', async () => {
    const userId = newUserId();
    const dk = todayKey();
    database.incrementTestUsage(userId, dk, 45);
    mockDelayMs.value = 120; // widen the window a broken implementation would race inside
    const before = mockCallCount;

    const cookie = sessionCookieFor(userId);
    // Must be a real 5-page PDF: a non-PDF mimetype always counts as 1 page
    // regardless of content (see src/utils/pageCounter.js), which would
    // silently turn this into a 1-vs-1 page test instead of 5-vs-5.
    const pdf5 = await makePdfBuffer(5);
    const fileA = { filename: 'concurrent-a.pdf', mimetype: 'application/pdf', buffer: pdf5 };
    const fileB = { filename: 'concurrent-b.pdf', mimetype: 'application/pdf', buffer: pdf5 };

    const [r1, r2] = await Promise.all([
      postExtract({ Cookie: cookie }, [fileA]),
      postExtract({ Cookie: cookie }, [fileB]),
    ]);
    mockDelayMs.value = 0;

    const statuses = [r1.status, r2.status].sort();
    assert.deepStrictEqual(statuses, [200, 429], 'exactly one request must succeed (200) and one must be rejected (429)');
    const rejected = r1.status === 429 ? r1 : r2;
    assert.strictEqual(rejected.body.code, 'TEST_DAILY_LIMIT_REACHED');

    const finalUsed = database.getTestUsage(userId, dk);
    assert.strictEqual(finalUsed, 50, 'final used must be exactly 50, not 55');
    assert.strictEqual(mockCallCount - before, 1, 'mocked extraction must have run exactly once (for the winning request only)');
  });

  await test('T4: successful extraction, no double count -- used=0, request=10 pages -> final test_usage EXACTLY 10', async () => {
    const userId = newUserId();
    const dk = todayKey();
    const cookie = sessionCookieFor(userId);
    const pdf = await makePdfBuffer(10);

    const r = await postExtract({ Cookie: cookie }, [{ filename: 'ten-pages.pdf', mimetype: 'application/pdf', buffer: pdf }]);
    assert.strictEqual(r.status, 200, 'expected 200, got ' + r.status + ' body=' + JSON.stringify(r.body));

    const used = database.getTestUsage(userId, dk);
    assert.strictEqual(used, 10, 'test_usage must be exactly 10, not 20 (no double count)');
  });

  await test('T5: total failure rollback -- used=0, request=10, extraction fails -> final test_usage=0', async () => {
    const userId = newUserId();
    const dk = todayKey();
    const cookie = sessionCookieFor(userId);
    const pdf = await makePdfBuffer(10);
    const filename = 'ten-pages-fail.pdf';
    failFilenames.add(filename);

    const r = await postExtract({ Cookie: cookie }, [{ filename, mimetype: 'application/pdf', buffer: pdf }]);
    failFilenames.delete(filename);
    assert.strictEqual(r.status, 200, 'route still returns 200 with an error record, got ' + r.status);

    const used = database.getTestUsage(userId, dk);
    assert.strictEqual(used, 0, 'all reserved quota must be released after total failure');
  });

  await test('T6: partial file failure -- fileA(3 pages, success) + fileB(7 pages, failure) -> reserved=10, released=7, final=3', async () => {
    const userId = newUserId();
    const dk = todayKey();
    const cookie = sessionCookieFor(userId);
    const pdfA = await makePdfBuffer(3);
    const pdfB = await makePdfBuffer(7);
    const failName = 'fileB-fails.pdf';
    failFilenames.add(failName);

    const r = await postExtract({ Cookie: cookie }, [
      { filename: 'fileA-ok.pdf', mimetype: 'application/pdf', buffer: pdfA },
      { filename: failName, mimetype: 'application/pdf', buffer: pdfB },
    ]);
    failFilenames.delete(failName);
    assert.strictEqual(r.status, 200, 'expected 200, got ' + r.status + ' body=' + JSON.stringify(r.body));

    const used = database.getTestUsage(userId, dk);
    assert.strictEqual(used, 3, 'final test_usage must be exactly 3 (10 reserved - 7 released for the failed file)');
  });

  await test('T7: multiple successful files -- 3 pages + 7 pages, both succeed -> final test_usage=10 exactly', async () => {
    const userId = newUserId();
    const dk = todayKey();
    const cookie = sessionCookieFor(userId);
    const pdfA = await makePdfBuffer(3);
    const pdfB = await makePdfBuffer(7);

    const r = await postExtract({ Cookie: cookie }, [
      { filename: 'a.pdf', mimetype: 'application/pdf', buffer: pdfA },
      { filename: 'b.pdf', mimetype: 'application/pdf', buffer: pdfB },
    ]);
    assert.strictEqual(r.status, 200);

    const used = database.getTestUsage(userId, dk);
    assert.strictEqual(used, 10, 'final test_usage must be exactly 10');
  });

  await test('T8: monthly isolation -- TEST_MODE successful request leaves users.scans_used unchanged', async () => {
    const userId = newUserId();
    const cookie = sessionCookieFor(userId);
    const pdf = await makePdfBuffer(4);

    const r = await postExtract({ Cookie: cookie }, [{ filename: 'iso.pdf', mimetype: 'application/pdf', buffer: pdf }]);
    assert.strictEqual(r.status, 200);

    const user = database.getUser(userId);
    assert.strictEqual(user.scans_used, 0, 'users.scans_used must remain 0 under TEST_MODE');
  });

  await test('T9: normal-mode regression -- TEST_MODE=false successful request increments users.scans_used exactly as before', async () => {
    process.env.TEST_MODE = 'false';
    const userId = newUserId();
    // Free plan limit is 5 pages/month: use 3 pages so this test exercises
    // "within limit" accounting, not the (correct, pre-existing) rejection.
    const pdf = await makePdfBuffer(3);

    // Legacy anonymous path still works (no auth requirement outside TEST_MODE)
    const r = await postExtract({ 'X-User-Id': userId }, [{ filename: 'legacy.pdf', mimetype: 'application/pdf', buffer: pdf }]);
    assert.strictEqual(r.status, 200, 'expected 200, got ' + r.status + ' body=' + JSON.stringify(r.body));

    const user = database.getUser(userId);
    assert.strictEqual(user.scans_used, 3, 'users.scans_used must be exactly 3');

    const dk = todayKey();
    assert.strictEqual(database.getTestUsage(userId, dk), 0, 'test_usage must stay 0 when TEST_MODE=false');
  });

  await test('T10: anonymous beta access denied -- TEST_MODE=true, X-User-Id only -> 401, no reservation, no mock call', async () => {
    const userId = newUserId();
    const dk = todayKey();
    const before = mockCallCount;
    const pdf = await makePdfBuffer(2);

    const r = await postExtract({ 'X-User-Id': userId }, [{ filename: 'anon.pdf', mimetype: 'application/pdf', buffer: pdf }]);
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.code, 'TEST_MODE_AUTH_REQUIRED');
    assert.strictEqual(database.getTestUsage(userId, dk), 0, 'no reservation must have happened');
    assert.strictEqual(mockCallCount, before, 'mock extraction must not have been called');
  });

  await test('T11: quota exceeded HTTP semantics -- 429, TEST_DAILY_LIMIT_REACHED, correct limit/used/resetAt', async () => {
    const userId = newUserId();
    const dk = todayKey();
    database.incrementTestUsage(userId, dk, 50); // already at limit
    const cookie = sessionCookieFor(userId);
    const pdf = await makePdfBuffer(1);

    const r = await postExtract({ Cookie: cookie }, [{ filename: 'over.pdf', mimetype: 'application/pdf', buffer: pdf }]);
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.body.code, 'TEST_DAILY_LIMIT_REACHED');
    assert.strictEqual(r.body.limit, 50);
    assert.strictEqual(r.body.used, 50);
    assert.ok(typeof r.body.resetAt === 'string' && r.body.resetAt.includes('T'), 'resetAt must be an ISO timestamp');
  });

  await test('T12: persistent test quota -- reopening the isolated DB file directly shows the same usage', async () => {
    const userId = newUserId();
    const dk = todayKey();
    database.incrementTestUsage(userId, dk, 17);

    const BetterSqlite3 = require('better-sqlite3');
    const freshConn = new BetterSqlite3(TEST_DB_PATH, { readonly: true });
    const row = freshConn.prepare('SELECT pages_used FROM test_usage WHERE user_id = ? AND date_key = ?').get(userId, dk);
    freshConn.close();

    assert.ok(row, 'row must exist when read from a brand-new connection to the same file');
    assert.strictEqual(row.pages_used, 17, 'usage must be readable from a fresh connection, proving it is persisted on disk');
  });

  await test('T13: zero-retention -- test_usage table has no document/file content columns', async () => {
    const cols = database.db.prepare('PRAGMA table_info(test_usage)').all().map((c) => c.name).sort();
    assert.deepStrictEqual(cols, ['created_at', 'date_key', 'pages_used', 'user_id'].sort());
  });

  await test('T14: independent math verification still runs on every record', async () => {
    const userId = newUserId();
    const cookie = sessionCookieFor(userId);
    const pdf = await makePdfBuffer(1);

    const r = await postExtract({ Cookie: cookie }, [{ filename: 'math.pdf', mimetype: 'application/pdf', buffer: pdf }]);
    assert.strictEqual(r.status, 200);
    const record = r.body.results[0];
    assert.ok(record._verification, 'response record must carry the independent _verification block');
    assert.strictEqual(record._verification.code_verified, true, '100 + 22 = 122 must verify independently');
  });

  await test('T15: burst limiter remains independent -- 4th request within a minute is rate-limited', async () => {
    const userId = newUserId();
    const cookie = sessionCookieFor(userId);
    const pdf = await makePdfBuffer(1);
    const results2 = [];
    for (let i = 0; i < 4; i++) {
      results2.push(await postExtract({ Cookie: cookie }, [{ filename: `burst${i}.pdf`, mimetype: 'application/pdf', buffer: pdf }]));
    }
    const statuses = results2.map((r) => r.status);
    assert.ok(statuses.includes(429), '4th request in the same minute must be rate-limited (429): got ' + JSON.stringify(statuses));
  });

  // -------------------------------------------------------------------
  // Database hygiene report
  // -------------------------------------------------------------------
  const userRowCount = database.db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const usageRowCount = database.db.prepare('SELECT COUNT(*) AS c FROM test_usage').get().c;

  console.log('\n=== Database hygiene (isolated test DB) ===');
  console.log('File used for this run:', TEST_DB_PATH);
  console.log('Rows created in users:', userRowCount);
  console.log('Rows created in test_usage:', usageRowCount);
  console.log('Real project database (data/invoice-extractor.sqlite) was never opened by this process.');

  // Close the live connection before removing its file (Windows keeps an
  // open handle on the .sqlite/-wal/-shm files otherwise), then remove the
  // whole temp directory (isolated DB + WAL/SHM files).
  try {
    database.db.close();
  } catch (e) {
    // non-fatal
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('Isolated temp database directory removed:', tmpDir);
  } catch (e) {
    console.log('Could not remove temp dir (non-fatal):', e.message);
  }

  console.log('\n=== SUMMARY ===');
  console.log('PASS: ' + pass);
  console.log('FAIL: ' + fail);
  console.log('TOTAL: ' + (pass + fail));

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
