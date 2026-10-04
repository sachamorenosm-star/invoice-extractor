// PDF page counting runs in ONE worker thread with a hard timeout: offline, real HTTP, isolated SQLite, mocked IA.
// Only SMALL malformed fixtures are used; the timeout is lowered per test so the suite stays fast.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
require('./helpers/offline');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-worker-'));
Object.assign(process.env, {
  TEST_DB_PATH: path.join(tmp, 'isolated.sqlite'), NODE_ENV: 'test', PORT: '34745',
  TEST_MODE: 'true', TEST_DAILY_EXTRACTION_LIMIT: '50', TEST_GLOBAL_DAILY_EXTRACTION_LIMIT: '500', MAX_PAGES_PER_FILE: '20',
  SESSION_SECRET: 'pdf-worker-test-only-secret-at-least-32-characters',
  ANTHROPIC_API_KEY: '', RESEND_API_KEY: '', STRIPE_SECRET_KEY: '',
  LAUNCH_MODE: 'waitlist', RATE_LIMIT_MAX_REQUESTS: '100000', PDF_PARSE_TIMEOUT_MS: '300',
});
const logs = [];
for (const method of ['log', 'warn', 'error']) console[method] = (...args) => logs.push(args.map(String).join(' '));

// Lifecycle observation without any production API: count Worker threads created/alive.
const workerThreads = require('worker_threads');
const workers = { created: 0, live: 0 };
workerThreads.Worker = class extends workerThreads.Worker {
  constructor(...args) { super(...args); workers.created++; workers.live++; this.once('exit', () => { workers.live--; }); }
};

const received = [];
let calls = 0;
const provider = require.resolve('../src/services/claudeService');
require.cache[provider] = { id: provider, filename: provider, loaded: true, exports: {
  extractInvoiceData: async (buffer) => {
    calls++; received.push(Buffer.from(buffer));
    return { records: [{ subtotal: 100, vat_amount: 22, total: 122, math_verified: true }], truncated: false, extractedCount: 1 };
  },
} };
require('../src/server');
const database = require('../src/services/database');
const { PDFDocument } = require('pdf-lib');
const jwt = require('jsonwebtoken');
const { getPdfParseTimeoutMs } = require('../src/utils/config');
const { countFilePages } = require('../src/utils/pageCounter');

let pass = 0, fail = 0, userNumber = 0;
const out = (message) => fs.writeSync(1, message + '\n');
async function test(name, fn) {
  try { await fn(); pass++; out('PASS: ' + name); }
  catch (error) { fail++; out('FAIL: ' + name + ' ' + error.message); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const asPdf = (buffer) => ({ mimetype: 'application/pdf', buffer });
async function pdf(pages, padBytes = 0) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  if (padBytes) await doc.attach(crypto.randomBytes(padBytes), 'pad.bin', { mimeType: 'application/octet-stream' });
  return Buffer.from(await doc.save());
}
// Header + random bytes: pdf-lib's synchronous junk scan needs about 0.8 s per 100 KB (inline).
const malformed = (bytes) => Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(bytes), Buffer.from('\n%%EOF')]);
function request(route, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request({ host: '127.0.0.1', port: 34745, path: route, method, headers: { ...headers, ...(body ? { 'Content-Length': body.length } : {}) } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - started, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end(body);
  });
}
function extractPromise(files) {
  const userId = 'usr_pdfworker-user-' + String(++userNumber).padStart(8, '0');
  const boundary = '----PdfWorkerBoundary';
  const parts = [];
  for (const file of files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="invoices"; filename="private-invoice.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), file, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const token = jwt.sign({ userId, email: 'private-user@example.test' }, process.env.SESSION_SECRET);
  const promise = request('/api/extract', 'POST', Buffer.concat(parts), { Cookie: 'ie_session=' + token, 'Content-Type': 'multipart/form-data; boundary=' + boundary })
    .then((result) => ({ ...result, body: JSON.parse(result.buffer), used: database.getTestUsage(userId, new Date().toISOString().split('T')[0]) }));
  return promise;
}

async function main() {
  await sleep(100);

  await test('valid 1-page PDF keeps its page count', async () => {
    assert.strictEqual(await countFilePages(asPdf(await pdf(1))), 1);
  });
  await test('valid multi-page PDFs keep their page counts (5 and 20 pages, with embedded payload)', async () => {
    assert.strictEqual(await countFilePages(asPdf(await pdf(5))), 5);
    assert.strictEqual(await countFilePages(asPdf(await pdf(20, 300000))), 20);
  });
  await test('non-PDF files still count as one page without parsing', async () => {
    assert.strictEqual(await countFilePages({ mimetype: 'image/png', buffer: Buffer.from('x') }), 1);
  });
  await test('original Buffer stays intact and usable after counting (copy, not transfer)', async () => {
    const original = await pdf(3); const snapshot = Buffer.from(original);
    assert.strictEqual(await countFilePages(asPdf(original)), 3);
    assert.strictEqual(original.length, snapshot.length); assert.ok(original.equals(snapshot));
    assert.strictEqual(await countFilePages(asPdf(original)), 3);
  });
  await test('truncated PDF rejected as PDF_UNPARSEABLE', async () => {
    const full = await pdf(3, 200000);
    await assert.rejects(countFilePages(asPdf(full.slice(0, Math.floor(full.length * 0.6)))), { code: 'PDF_UNPARSEABLE' });
  });
  await test('invalid text and empty buffers rejected as PDF_UNPARSEABLE', async () => {
    await assert.rejects(countFilePages(asPdf(Buffer.from('not a PDF'))), { code: 'PDF_UNPARSEABLE' });
    await assert.rejects(countFilePages(asPdf(Buffer.alloc(0))), { code: 'PDF_UNPARSEABLE' });
  });
  await test('pathological malformed PDF is bounded by the timeout', async () => {
    const started = Date.now();
    await assert.rejects(countFilePages(asPdf(malformed(300000))), { code: 'PDF_UNPARSEABLE' });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, 'took ' + elapsed + ' ms'); // inline parsing needs about 2.3 s for this sample
    assert.ok(logs.some((line) => line.includes('[pageCounter] error_code=PDF_PARSE_TIMEOUT') && line.includes('"duration_ms":') && line.includes('"file_bytes":')), JSON.stringify(logs.slice(-4)));
  });
  await test('timeout terminates the CPU work', async () => {
    await assert.rejects(countFilePages(asPdf(malformed(400000))), { code: 'PDF_UNPARSEABLE' });
    await sleep(100); // let termination settle
    const before = process.cpuUsage(); await sleep(1000); const used = process.cpuUsage(before);
    assert.ok(used.user / 1000 < 500, 'process kept burning CPU: ' + Math.round(used.user / 1000) + ' ms in 1 s');
  });
  await test('main event loop stays responsive during a pathological parse', async () => {
    process.env.PDF_PARSE_TIMEOUT_MS = '1000';
    try {
      let last = Date.now(), maxGap = 0, ticks = 0;
      const timer = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++; }, 25);
      const started = Date.now();
      await assert.rejects(countFilePages(asPdf(malformed(400000))), { code: 'PDF_UNPARSEABLE' });
      clearInterval(timer);
      assert.ok(Date.now() - started >= 800, 'the parse should have been busy for about the timeout');
      assert.ok(ticks >= 15, 'only ' + ticks + ' timer ticks');
      assert.ok(maxGap < 400, 'event loop stalled for ' + maxGap + ' ms');
    } finally { process.env.PDF_PARSE_TIMEOUT_MS = '300'; }
  });
  await test('queued valid PDF succeeds after a timeout on a fresh worker', async () => {
    const createdBefore = workers.created;
    const results = await Promise.allSettled([countFilePages(asPdf(malformed(300000))), countFilePages(asPdf(await pdf(3)))]);
    assert.strictEqual(results[0].status, 'rejected'); assert.strictEqual(results[0].reason.code, 'PDF_UNPARSEABLE');
    assert.strictEqual(results[1].status, 'fulfilled'); assert.strictEqual(results[1].value, 3);
    assert.ok(workers.created > createdBefore, 'the worker should have been replaced');
  });
  await test('repeated malformed parses never accumulate workers or break the queue', async () => {
    for (let i = 0; i < 5; i++) await assert.rejects(countFilePages(asPdf(malformed(100000))), { code: 'PDF_UNPARSEABLE' });
    process.env.PDF_PARSE_TIMEOUT_MS = '150';
    try {
      const burst = await Promise.allSettled(Array.from({ length: 3 }, () => countFilePages(asPdf(malformed(100000)))));
      assert.ok(burst.every((r) => r.status === 'rejected'));
    } finally { process.env.PDF_PARSE_TIMEOUT_MS = '300'; }
    assert.strictEqual(await countFilePages(asPdf(await pdf(2))), 2);
    await sleep(300);
    assert.ok(workers.live <= 1, workers.live + ' workers alive');
  });
  await test('only one worker is alive while a request queues several PDFs', async () => {
    const buffers = await Promise.all([pdf(1), pdf(2), pdf(4), pdf(5)]);
    const counts = await Promise.all(buffers.map((buffer) => countFilePages(asPdf(buffer))));
    assert.deepStrictEqual(counts, [1, 2, 4, 5]);
    await sleep(200);
    assert.ok(workers.live <= 1, workers.live + ' workers alive');
  });
  await test('timed-out PDF over HTTP: IA not called, no quota, row error PDF_UNPARSEABLE', async () => {
    const before = calls;
    const result = await extractPromise([malformed(300000)]);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.results[0].error_code, 'PDF_UNPARSEABLE');
    assert.strictEqual(result.body.results[0].math_verified, false);
    assert.strictEqual(result.body.pagesProcessed, 0);
    assert.strictEqual(calls, before); assert.strictEqual(result.used, 0);
    assert.ok(!JSON.stringify(result.body).includes('PDF_PARSE_TIMEOUT'), 'internal timeout detail leaked to the client');
  });
  await test('/api/health answers quickly while a pathological PDF is being parsed', async () => {
    process.env.PDF_PARSE_TIMEOUT_MS = '1000';
    try {
      const pending = extractPromise([malformed(400000)]);
      await sleep(250);
      const health = await request('/api/health', 'GET');
      assert.strictEqual(health.status, 200);
      assert.ok(health.ms < 300, 'health took ' + health.ms + ' ms');
      const result = await pending;
      assert.strictEqual(result.body.results[0].error_code, 'PDF_UNPARSEABLE');
    } finally { process.env.PDF_PARSE_TIMEOUT_MS = '300'; }
  });
  await test('mixed request valid + malformed + valid: valid files processed with intact buffers, quota only for valid pages', async () => {
    const first = await pdf(2), third = await pdf(1);
    const before = calls; received.length = 0;
    const result = await extractPromise([first, malformed(300000), third]);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.results.length, 3);
    assert.strictEqual(result.body.results[1].error_code, 'PDF_UNPARSEABLE');
    assert.ok(!result.body.results[0].error_code && !result.body.results[2].error_code);
    assert.strictEqual(calls - before, 2); assert.strictEqual(result.used, 3); assert.strictEqual(result.body.pagesProcessed, 3);
    assert.ok(received[0].equals(first) && received[1].equals(third), 'provider received altered bytes');
  });
  await test('timeout and crash logs contain only safe metadata', () => {
    const all = logs.join('\n');
    for (const forbidden of ['private-invoice.pdf', 'private-user@example.test', process.env.SESSION_SECRET, '%PDF']) assert.ok(!all.includes(forbidden), forbidden);
    assert.ok(all.includes('PDF_PARSE_TIMEOUT'));
  });
  await test('PDF_PARSE_TIMEOUT_MS: default 3000 and strict validation', () => {
    const configured = process.env.PDF_PARSE_TIMEOUT_MS; delete process.env.PDF_PARSE_TIMEOUT_MS;
    try { assert.strictEqual(getPdfParseTimeoutMs(), 3000); } finally { process.env.PDF_PARSE_TIMEOUT_MS = configured; }
    assert.strictEqual(getPdfParseTimeoutMs('1'), 1); assert.strictEqual(getPdfParseTimeoutMs('60000'), 60000);
    for (const raw of ['0', '-1', '1.5', 'abc', '', ' 5', '5 ', '1e3', '60001', '99999', '100000']) assert.throws(() => getPdfParseTimeoutMs(raw), /Invalid PDF_PARSE_TIMEOUT_MS/, JSON.stringify(raw));
  });
  for (const raw of ['0', 'abc', '', '60001']) {
    await test('invalid PDF_PARSE_TIMEOUT_MS fails startup clearly: ' + JSON.stringify(raw), () => {
      const result = spawnSync(process.execPath, ['src/server.js'], { encoding: 'utf8', env: { ...process.env, PDF_PARSE_TIMEOUT_MS: raw, NODE_ENV: 'production', PORT: '34746', TEST_DB_PATH: path.join(tmp, 'must-not-open.sqlite') } });
      assert.notStrictEqual(result.status, 0); assert.match(result.stderr, /Invalid PDF_PARSE_TIMEOUT_MS/);
      assert.ok(!fs.existsSync(path.join(tmp, 'must-not-open.sqlite')));
      assert.ok(!result.stderr.includes(process.env.SESSION_SECRET));
    });
  }
  database.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  out(`PASS: ${pass}\nFAIL: ${fail}\nSKIPPED: 0\nTOTAL: ${pass + fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((error) => { out('FATAL: ' + error.stack); process.exit(1); });
