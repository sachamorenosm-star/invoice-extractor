// Offline integration regressions: real HTTP, isolated SQLite, mocked IA.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawnSync } = require('child_process');
require('./helpers/offline');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-beta-'));
Object.assign(process.env, {
  TEST_DB_PATH: path.join(tmp, 'isolated.sqlite'), NODE_ENV: 'test', PORT: '34741',
  TEST_MODE: 'true', TEST_DAILY_EXTRACTION_LIMIT: '50', MAX_PAGES_PER_FILE: '20',
  SESSION_SECRET: 'pre-beta-test-only-secret-at-least-32-characters',
  ANTHROPIC_API_KEY: '', RESEND_API_KEY: '', STRIPE_SECRET_KEY: '',
  LAUNCH_MODE: 'waitlist', RATE_LIMIT_MAX_REQUESTS: '100000',
});
const logs = [];
for (const method of ['log', 'warn', 'error']) console[method] = (...args) => logs.push(args.map(String).join(' '));
let calls = 0;
const provider = require.resolve('../src/services/claudeService');
require.cache[provider] = { id: provider, filename: provider, loaded: true, exports: {
  extractInvoiceData: async (buffer, mime, filename) => {
    calls++;
    if (filename === 'provider-failure.pdf') throw new Error('private-invoice-marker');
    return { records: [{ subtotal: 100, vat_amount: 22, total: 122, math_verified: true }], truncated: false, extractedCount: 1 };
  },
} };
require('../src/server');
const database = require('../src/services/database');
const { PDFDocument } = require('pdf-lib');
const ExcelJS = require('exceljs');
const jwt = require('jsonwebtoken');
const { parseTestMode, getMaxPagesPerFile, startupSummary } = require('../src/utils/config');
const { sanitizeExportRows } = require('../src/utils/validators');
const { verifyInvoiceMath } = require('../src/utils/mathVerifier');
const { generateCsv } = require('../src/services/excelService');
const { countFilePages } = require('../src/utils/pageCounter');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
// Execute actual frontend helpers from the IIFE without browser setup.
// CRLF source is also supported.
const end = source.indexOf('  // Download Excel');
const start = source.indexOf('  function toNumberOrNull(');
const context = vm.createContext({ state: { rows: [] } });
vm.runInContext(source.slice(start, end).replace(/\s*\/\/ -+\s*$/, ''), context);
let pass = 0, fail = 0, userNumber = 0;
const out = (message) => fs.writeSync(1, message + '\n');
async function test(name, fn) {
  try { await fn(); pass++; out('PASS: ' + name); }
  catch (error) { fail++; out('FAIL: ' + name + ' ' + error.message); }
}
const valid = { subtotal: 100, vat_amount: 22, total: 122, currency: 'EUR', math_verified: true };
function request(route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 34741, path: route, method: 'POST', headers: { ...headers, 'Content-Length': body.length } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function pdf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  return Buffer.from(await doc.save());
}
async function extract(files, extraHeaders = {}) {
  const userId = 'usr_prebeta-user-' + String(++userNumber).padStart(8, '0');
  const boundary = '----PreBetaBoundary';
  const parts = [];
  for (const file of files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="invoices"; filename="${file.name || 'private-invoice.pdf'}"\r\nContent-Type: application/pdf\r\n\r\n`), file.buffer, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const token = jwt.sign({ userId, email: 'private-user@example.test' }, process.env.SESSION_SECRET);
  const result = await request('/api/extract', Buffer.concat(parts), { Cookie: 'ie_session=' + token, 'Content-Type': 'multipart/form-data; boundary=' + boundary, ...extraHeaders });
  result.body = JSON.parse(result.buffer);
  result.used = database.getTestUsage(userId, new Date().toISOString().split('T')[0]);
  return result;
}
async function main() {
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const [raw, expected] of [['true', true], ['false', false], [undefined, false]]) {
    await test('TEST_MODE ' + String(raw), () => assert.strictEqual(parseTestMode(raw), expected));
  }
  for (const raw of ['True', 'TRUE', '1', 'yes', 'abc', '', ' true ']) {
    await test('invalid TEST_MODE fails startup: ' + JSON.stringify(raw), () => {
      const result = spawnSync(process.execPath, ['src/server.js'], { encoding: 'utf8', env: { ...process.env, TEST_MODE: raw, NODE_ENV: 'production', TEST_DB_PATH: path.join(tmp, 'must-not-open.sqlite') } });
      assert.notStrictEqual(result.status, 0); assert.match(result.stderr, /Invalid TEST_MODE/);
      assert.ok(!fs.existsSync(path.join(tmp, 'must-not-open.sqlite')));
      assert.ok(!result.stderr.includes(process.env.SESSION_SECRET));
    });
  }
  await test('page cap default/configuration guard', () => {
    const previous = process.env.MAX_PAGES_PER_FILE;
    delete process.env.MAX_PAGES_PER_FILE;
    try { assert.strictEqual(getMaxPagesPerFile(), 20); }
    finally { process.env.MAX_PAGES_PER_FILE = previous; }
    assert.strictEqual(getMaxPagesPerFile('3'), 3);
    for (const raw of ['0', '-1', 'abc', '20pages', '', '1.5']) assert.throws(() => getMaxPagesPerFile(raw));
  });
  const cases = [
    ['valid amounts', valid, true],
    ['missing subtotal', { ...valid, subtotal: null }, false],
    ['missing VAT', { ...valid, vat_amount: undefined }, false],
    ['missing total', { ...valid, total: '' }, false],
    ['failed extraction', { subtotal: null, vat_amount: null, total: null, math_verified: false }, false],
    ['real zero', { subtotal: 0, vat_amount: 0, total: 0 }, true],
    ['whitespace', { ...valid, subtotal: ' ' }, false],
    ['non-numeric', { ...valid, total: '122garbage' }, false],
    ['boolean', { subtotal: false, vat_amount: false, total: false }, false],
    ['decimal comma', { subtotal: '100,00', vat_amount: '22,00', total: '122,00' }, true],
  ];
  for (const [name, row, expected] of cases) {
    await test('server/export numbers: ' + name, async () => {
      const sanitized = sanitizeExportRows([row])[0];
      assert.strictEqual(verifyInvoiceMath(row).verified, expected);
      assert.strictEqual(verifyInvoiceMath(sanitized).verified, expected);
      const body = Buffer.from(JSON.stringify({ rows: [row] }));
      const csv = await request('/api/export/csv', body, { 'Content-Type': 'application/json' });
      assert.strictEqual(csv.status, 200);
      const cells = csv.buffer.toString('utf8').split('\r\n')[3].split(';');
      assert.strictEqual(cells[7], expected ? 'OK' : 'Da verificare');
      const xlsx = await request('/api/export/xlsx', body, { 'Content-Type': 'application/json' });
      assert.strictEqual(xlsx.status, 200);
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(xlsx.buffer);
      const sheet = workbook.getWorksheet('Fatture Estratte');
      assert.strictEqual(sheet.getCell('H6').value, expected ? '✓ OK' : '⚠ Da verificare');
      for (const [key, column] of [['subtotal', 'E6'], ['vat_amount', 'F6'], ['total', 'G6']]) {
        assert.strictEqual(sheet.getCell(column).value, sanitized[key]);
        if (sanitized[key] === null) assert.strictEqual(cells[{ subtotal: 4, vat_amount: 5, total: 6 }[key]], '');
      }
    });
    await test('frontend numbers: ' + name, () => {
      context.state.rows = [{ ...row }]; context.recomputeVerification(0);
      assert.strictEqual(context.state.rows[0].math_verified, expected);
      if (Object.values(row).some((value) => value === null || value === undefined || value === '')) assert.strictEqual(context.computeMathSuggestion(row), null);
    });
  }
  await test('frontend edits preserve missing values and numeric zero', () => {
    for (const value of [null, undefined, '', ' ', 'garbage', false]) assert.strictEqual(context.toNumberOrNull(value), null);
    assert.strictEqual(context.toNumberOrNull('0'), 0);
    assert.ok(source.includes('value = toNumberOrNull(value);'));
    assert.strictEqual(context.formatNum(null), ''); assert.strictEqual(context.formatNum(0), '0.00');
  });
  await test('all missing/invalid variants fail verification in every required field', () => {
    for (const field of ['subtotal', 'vat_amount', 'total']) {
      for (const value of [null, undefined, '', ' ', 'garbage', '122garbage', NaN, Infinity, false, [], {}]) {
        const row = { ...valid, [field]: value };
        assert.strictEqual(verifyInvoiceMath(row).verified, false);
        assert.strictEqual(verifyInvoiceMath(sanitizeExportRows([row])[0]).verified, false);
        assert.strictEqual(context.verifyRowMath(row), false);
      }
    }
    assert.ok(source.includes('row.math_verified !== true || !verifyRowMath(row)'));
  });
  await test('small PDF normal path', async () => {
    const before = calls; const result = await extract([{ buffer: await pdf(2) }]);
    assert.strictEqual(result.status, 200); assert.strictEqual(result.body.pagesProcessed, 2);
    assert.strictEqual(calls - before, 1); assert.strictEqual(result.used, 2);
  });
  await test('corrupt PDF rejected, zero provider calls and zero quota', async () => {
    const before = calls; const buffer = Buffer.from('not a PDF');
    await assert.rejects(countFilePages({ mimetype: 'application/pdf', buffer }), { code: 'PDF_UNPARSEABLE' });
    const result = await extract([{ buffer }]);
    assert.strictEqual(result.body.results[0].error_code, 'PDF_UNPARSEABLE');
    assert.strictEqual(result.body.results[0].math_verified, false);
    assert.strictEqual(calls, before); assert.strictEqual(result.used, 0);
    assert.strictEqual(result.body.pagesProcessed, 0);
    const exported = generateCsv(sanitizeExportRows(result.body.results)).split('\r\n')[3];
    assert.ok(exported.includes('Da verificare')); assert.ok(!exported.includes('0.00'));
  });
  await test('PDF exactly at cap accepted', async () => {
    const before = calls; const result = await extract([{ buffer: await pdf(20) }]);
    assert.strictEqual(calls - before, 1); assert.strictEqual(result.used, 20);
    assert.strictEqual(result.body.pagesProcessed, 20);
  });
  await test('PDF above cap rejected, zero provider calls and zero quota', async () => {
    const before = calls; const result = await extract([{ buffer: await pdf(21) }]);
    assert.strictEqual(result.body.results[0].error_code, 'MAX_PAGES_PER_FILE_EXCEEDED');
    assert.strictEqual(calls, before); assert.strictEqual(result.used, 0);
  });
  await test('mixed files retain only accepted quota and process valid PDF', async () => {
    const before = calls; const result = await extract([{ buffer: Buffer.from('corrupt') }, { buffer: await pdf(21) }, { buffer: await pdf(2) }]);
    assert.strictEqual(result.status, 200); assert.strictEqual(calls - before, 1);
    assert.strictEqual(result.body.results.length, 3); assert.strictEqual(result.used, 2);
  });
  await test('configurable cap enforced at runtime', async () => {
    process.env.MAX_PAGES_PER_FILE = '1';
    try { const before = calls; const result = await extract([{ buffer: await pdf(2) }]); assert.strictEqual(calls, before); assert.strictEqual(result.used, 0); }
    finally { process.env.MAX_PAGES_PER_FILE = '20'; }
  });
  await test('provider failure releases accepted quota', async () => {
    const result = await extract([{ buffer: await pdf(2), name: 'provider-failure.pdf' }]);
    assert.strictEqual(result.used, 0); assert.strictEqual(result.body.results[0].math_verified, false);
  });
  await test('request IDs generated server-side, unique and returned', async () => {
    const a = await extract([{ buffer: await pdf(1) }], { 'X-Request-Id': 'client-private-marker' });
    const b = await extract([{ buffer: await pdf(1) }]);
    const id = a.headers['x-request-id']; assert.match(id, /^[0-9a-f-]{36}$/);
    assert.notStrictEqual(id, b.headers['x-request-id']); assert.notStrictEqual(id, 'client-private-marker');
    assert.ok(logs.some((log) => log.includes(id) && log.includes('request completed')));
  });
  await test('failed request lifecycle recorded safely', async () => {
    const result = await request('/api/extract', Buffer.alloc(0));
    assert.strictEqual(result.status, 401);
    assert.ok(logs.some((log) => log.includes(result.headers['x-request-id']) && log.includes('request failed') && log.includes('HTTP_401')));
  });
  await test('startup summary exposes configuration only', () => {
    const env = { ...process.env, ANTHROPIC_API_KEY: 'secret-anthropic-marker', RESEND_API_KEY: 'secret-resend-marker' };
    const summary = startupSummary(env, 50, { MAX_FILE_SIZE_MB: 10, MAX_FILES_PER_REQUEST: 10 });
    assert.strictEqual(summary.TEST_MODE, 'enabled'); assert.strictEqual(summary.MAX_PAGES_PER_FILE, 20);
    assert.strictEqual(summary.SQLITE_DB_PATH, path.resolve(process.env.TEST_DB_PATH));
    assert.strictEqual(summary.ANTHROPIC_CONFIGURED, 'YES'); assert.strictEqual(summary.RESEND_CONFIGURED, 'YES');
    assert.ok(!JSON.stringify(summary).includes('secret-'));
    assert.ok(logs.some((log) => log.includes('[server] configuration')));
  });
  await test('outcome logs include counts and no invoice PII or secrets', () => {
    const all = logs.join('\n');
    for (const forbidden of ['private-invoice.pdf', 'private-invoice-marker', 'private-user@example.test', 'client-private-marker', process.env.SESSION_SECRET]) assert.ok(!all.includes(forbidden), forbidden);
    assert.ok(all.includes('"success_count":1,"failure_count":2'));
    assert.ok(all.includes('"duration_ms":')); assert.ok(all.includes('"error_code":"FILE_FAILURE"'));
    const providerSource = fs.readFileSync(provider, 'utf8');
    for (const line of providerSource.split('\n').filter((line) => line.includes('console.'))) assert.ok(!line.includes('filename') && !line.includes('err.message'));
  });
  database.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  out(`PASS: ${pass}\nFAIL: ${fail}\nSKIPPED: 0\nTOTAL: ${pass + fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((error) => { out('FATAL: ' + error.stack); process.exit(1); });
