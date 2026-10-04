const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawnSync, fork } = require('child_process');
require('./helpers/offline');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'global-beta-cap-'));
Object.assign(process.env, {
  TEST_DB_PATH: path.join(directory, 'synthetic.sqlite'), NODE_ENV: 'test', PORT: '34743',
  TEST_MODE: 'true', TEST_DAILY_EXTRACTION_LIMIT: '50', TEST_GLOBAL_DAILY_EXTRACTION_LIMIT: '15',
  SESSION_SECRET: 'global-beta-cap-synthetic-secret-32-plus', RATE_LIMIT_MAX_REQUESTS: '100000',
});
const originalDate = Date;
let calls = 0, behavior = 'success', unblock;
const warnings = [];
const warn = console.warn;
console.warn = (...args) => { warnings.push(args); };
function setTime(iso) {
  global.Date = class extends originalDate {
    constructor(...args) { super(...(args.length ? args : [iso])); }
    static now() { return new originalDate(iso).getTime(); }
  };
}
const provider = require.resolve('../src/services/claudeService');
require.cache[provider] = { id: provider, filename: provider, loaded: true, exports: {
  extractInvoiceData: async (buffer, mime, filename) => {
    calls++;
    if (behavior === 'barrier') await new Promise(resolve => { unblock.push(resolve); });
    if (behavior === 'midnight-fail') { setTime('2026-10-05T00:00:01Z'); throw new Error('synthetic failure'); }
    if (behavior === 'fail' || filename === 'failed.pdf') throw new Error('synthetic failure');
    return { records: [{ subtotal: 1, vat_amount: 0, total: 1 }], truncated: false, extractedCount: 1 };
  },
} };
require('../src/server');
const database = require('../src/services/database');
const service = require('../src/services/stripeService');
const { getTestGlobalDailyLimit } = require('../src/utils/config');
const { PDFDocument } = require('pdf-lib');
const jwt = require('jsonwebtoken');
const D = require('better-sqlite3');
let pass = 0, fail = 0, number = 0;
const day = () => new Date().toISOString().slice(0, 10);
function reset(limit = 15) {
  global.Date = originalDate; behavior = 'success'; calls = 0;
  database.db.exec('DELETE FROM test_usage; DELETE FROM global_test_usage');
  process.env.TEST_GLOBAL_DAILY_EXTRACTION_LIMIT = String(limit);
  process.env.TEST_DAILY_EXTRACTION_LIMIT = '50';
  process.env.TEST_MODE = 'true';
}
async function test(name, fn) {
  reset();
  try { await fn(); pass++; console.log('PASS: ' + name); }
  catch (error) { fail++; console.error('FAIL: ' + name, error); }
  finally { global.Date = originalDate; }
}
function request(route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 34743, method: body ? 'POST' : 'GET', path: route,
      headers: { ...headers, ...(body ? { 'Content-Length': body.length } : {}) } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(body);
  });
}
async function extract(files) {
  const userId = 'usr_global-synthetic-' + (++number);
  const cookie = 'ie_session=' + jwt.sign({ userId, email: 'synthetic@example.invalid' }, process.env.SESSION_SECRET);
  const chunks = [], boundary = 'GlobalCapBoundary';
  for (const file of files) {
    let buffer;
    if (file.invalid) buffer = Buffer.from('invalid PDF');
    else { const pdf = await PDFDocument.create(); for (let i = 0; i < file.pages; i++) pdf.addPage(); buffer = Buffer.from(await pdf.save()); }
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="invoices"; filename="${file.name || 'synthetic.pdf'}"\r\nContent-Type: application/pdf\r\n\r\n`), buffer, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { ...await request('/api/extract', Buffer.concat(chunks), { Cookie: cookie, 'Content-Type': 'multipart/form-data; boundary=' + boundary }), userId };
}
function workers() {
  const children = Array.from({ length: 3 }, () => fork(path.join(__dirname, 'helpers/reserve-global-quota.js'), [], { env: process.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
  return Promise.all(children.map((child, index) => new Promise((resolve, reject) => {
    let result;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Worker timeout')); }, 10000);
    child.on('message', message => {
      if (message === 'ready') child.send({ userId: 'worker-' + index, day: day() });
      else result = message;
    });
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); code === 0 && result ? resolve(result) : reject(new Error('Worker failed')); });
  })));
}
async function main() {
  await test('production missing cap fails before opening SQLite', () => {
    const target = path.join(directory, 'must-not-open.sqlite');
    const result = spawnSync(process.execPath, ['src/server.js'], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', TEST_GLOBAL_DAILY_EXTRACTION_LIMIT: '', TEST_DB_PATH: target } });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Invalid TEST_GLOBAL_DAILY_EXTRACTION_LIMIT/); assert.ok(!fs.existsSync(target));
    assert.throws(() => getTestGlobalDailyLimit({ TEST_MODE: 'true', NODE_ENV: 'production' }));
  });
  for (const value of ['', '0', '-1', 'abc', '1.5', ' 15 ', '15pages', '9007199254740992']) {
    await test('invalid cap rejected: ' + JSON.stringify(value), () => assert.throws(() => getTestGlobalDailyLimit({ TEST_MODE: 'true', NODE_ENV: 'production', TEST_GLOBAL_DAILY_EXTRACTION_LIMIT: value })));
  }
  await test('positive integer accepted; normal mode ignores invalid cap', () => {
    assert.equal(getTestGlobalDailyLimit({ TEST_MODE: 'true', TEST_GLOBAL_DAILY_EXTRACTION_LIMIT: '15' }), 15);
    assert.equal(getTestGlobalDailyLimit({ TEST_MODE: 'false', TEST_GLOBAL_DAILY_EXTRACTION_LIMIT: 'bad' }), null);
  });
  await test('missing cap also fails closed in development and tests', () => {
    for (const NODE_ENV of ['development', 'test']) assert.throws(() => getTestGlobalDailyLimit({ TEST_MODE: 'true', NODE_ENV }));
  });
  await test('first request reserves globally before provider, persists on fresh connection', async () => {
    const result = await extract([{ pages: 8 }]); assert.equal(result.status, 200); assert.equal(calls, 1);
    assert.equal(database.getGlobalTestUsage(day()), 8); assert.equal(database.getTestUsage(result.userId, day()), 8);
    const other = new D(process.env.TEST_DB_PATH, { readonly: true });
    try { assert.equal(other.prepare('SELECT pages_used FROM global_test_usage WHERE date_key=?').get(day()).pages_used, 8); }
    finally { other.close(); }
  });
  await test('Alice 8 + Bob 7 reaches 15; Carol blocked with unused personal quota', async () => {
    assert.equal((await extract([{ pages: 8 }])).status, 200);
    assert.equal((await extract([{ pages: 7 }])).status, 200);
    const before = calls, result = await extract([{ pages: 1 }]);
    assert.equal(result.status, 429); assert.equal(result.body.code, 'TEST_GLOBAL_DAILY_LIMIT_REACHED');
    assert.equal(calls, before); assert.equal(database.getGlobalTestUsage(day()), 15);
    assert.equal(database.getTestUsage(result.userId, day()), 0);
    assert.deepEqual(Object.keys(result.body).sort(), ['code', 'error']);
  });
  await test('global block invokes provider zero times', async () => {
    database.db.prepare('INSERT INTO global_test_usage VALUES (?,15,0)').run(day());
    assert.equal((await extract([{ pages: 1 }])).status, 429); assert.equal(calls, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM test_usage').get().n, 0);
  });
  await test('personal rejection leaves both counters unchanged', () => {
    process.env.TEST_DAILY_EXTRACTION_LIMIT = '5';
    const result = service.reserveTestDailyQuotaResult('personal-synthetic', 6);
    assert.equal(result.reason, 'user'); assert.equal(database.getGlobalTestUsage(day()), 0);
    assert.equal(database.getTestUsage('personal-synthetic', day()), 0);
  });
  await test('real parallel HTTP 8+8+8 with cap 20 never reserves 24', async () => {
    process.env.TEST_GLOBAL_DAILY_EXTRACTION_LIMIT = '20'; behavior = 'barrier'; unblock = [];
    const requests = [extract([{ pages: 8 }]), extract([{ pages: 8 }]), extract([{ pages: 8 }])];
    let timer;
    try {
      const first = await Promise.race([...requests, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HTTP barrier timeout')), 8000); })]);
      assert.equal(first.status, 429); assert.equal(database.getGlobalTestUsage(day()), 16); assert.equal(calls, 2);
    } finally { clearTimeout(timer); behavior = 'success'; unblock.forEach(resolve => resolve()); }
    const results = await Promise.all(requests);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 200, 429]);
    assert.equal(database.getGlobalTestUsage(day()), 16);
    assert.equal(results.reduce((sum, result) => sum + database.getTestUsage(result.userId, day()), 0), 16);
  });
  await test('three independent SQLite processes reserve at most 20', async () => {
    const results = await workers();
    assert.equal(results.filter(result => result.success).length, 2); assert.equal(database.getGlobalTestUsage(day()), 16);
    assert.equal(database.db.prepare('SELECT SUM(pages_used) AS n FROM test_usage').get().n, 16);
  });
  await test('provider total failure releases both quotas preserving earlier usage', async () => {
    await extract([{ pages: 3 }]); behavior = 'fail'; const result = await extract([{ pages: 7 }]);
    assert.equal(result.status, 200); assert.equal(database.getGlobalTestUsage(day()), 3);
    assert.equal(database.getTestUsage(result.userId, day()), 0);
  });
  await test('partial success 3+7 charges only successful 3 to both quotas', async () => {
    const result = await extract([{ pages: 3 }, { pages: 7, name: 'failed.pdf' }]);
    assert.equal(result.status, 200); assert.equal(calls, 2);
    assert.equal(database.getGlobalTestUsage(day()), 3); assert.equal(database.getTestUsage(result.userId, day()), 3);
  });
  await test('pre-provider invalid file is not charged; valid file is charged once', async () => {
    const result = await extract([{ invalid: true }, { pages: 3 }]);
    assert.equal(result.status, 200); assert.equal(calls, 1);
    assert.equal(database.getGlobalTestUsage(day()), 3); assert.equal(database.getTestUsage(result.userId, day()), 3);
  });
  await test('UTC day key and fresh day quota independent', () => {
    setTime('2026-10-04T23:59:59Z'); const yesterday = service.reserveTestDailyQuotaResult('same-user', 15);
    setTime('2026-10-05T00:00:01Z'); const today = service.reserveTestDailyQuotaResult('same-user', 15);
    assert.equal(yesterday.dateKey, '2026-10-04'); assert.equal(today.dateKey, '2026-10-05');
    assert.equal(database.getGlobalTestUsage(yesterday.dateKey), 15); assert.equal(database.getGlobalTestUsage(today.dateKey), 15);
  });
  await test('over-page-cap file rejected before provider without either charge', async () => {
    const result = await extract([{ pages: 21 }]);
    assert.equal(result.status, 200); assert.equal(calls, 0);
    assert.equal(database.getGlobalTestUsage(day()), 0); assert.equal(database.getTestUsage(result.userId, day()), 0);
  });
  await test('normal extraction ignores invalid global cap and leaves beta counters untouched', async () => {
    process.env.TEST_MODE = 'false'; process.env.TEST_GLOBAL_DAILY_EXTRACTION_LIMIT = 'invalid';
    const result = await extract([{ pages: 1 }]);
    assert.equal(result.status, 200); assert.equal(calls, 1); assert.equal(database.getGlobalTestUsage(day()), 0);
    assert.equal(database.getTestUsage(result.userId, day()), 0);
  });
  await test('HTTP failure across midnight releases reservation day only', async () => {
    setTime('2026-10-04T23:59:59Z');
    database.db.prepare('INSERT INTO global_test_usage VALUES (?,4,0)').run('2026-10-05');
    behavior = 'midnight-fail'; const result = await extract([{ pages: 7 }]);
    assert.equal(result.status, 200); assert.equal(database.getGlobalTestUsage('2026-10-04'), 0);
    assert.equal(database.getGlobalTestUsage('2026-10-05'), 4);
    assert.equal(database.getTestUsage(result.userId, '2026-10-04'), 0);
  });
  await test('safe blocked log contains only operational fields', async () => {
    database.db.prepare('INSERT INTO global_test_usage VALUES (?,15,0)').run(day());
    const result = await extract([{ pages: 1 }]);
    const entry = warnings.filter(args => args[0] === '[test-mode] global quota blocked').at(-1);
    const fields = JSON.parse(entry[1]);
    assert.deepEqual(Object.keys(fields).sort(), ['date_key', 'global_limit', 'global_pages_used', 'request_id', 'requested_pages']);
    assert.equal(fields.request_id, result.headers['x-request-id']); assert.equal(fields.global_limit, 15);
    assert.ok(!JSON.stringify(entry).includes('synthetic@')); assert.ok(!JSON.stringify(entry).includes('.pdf'));
  });
  await test('public config omits global limit; counter has no personal data', async () => {
    const config = (await request('/api/config')).body;
    assert.ok(!Object.keys(config).some(key => /global/i.test(key)));
    assert.deepEqual(database.db.pragma('table_info(global_test_usage)').map(row => row.name).sort(), ['created_at', 'date_key', 'pages_used']);
  });
  await test('actual frontend global-limit mapping displays beta-cap message', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    const start = source.indexOf("        if (res.status === 429 && data.code === 'TEST_GLOBAL_DAILY_LIMIT_REACHED')");
    const end = source.indexOf("        if (res.status === 429 && data.code === 'TEST_DAILY_LIMIT_REACHED')", start);
    let message;
    const context = vm.createContext({ res: { status: 429 }, data: { code: 'TEST_GLOBAL_DAILY_LIMIT_REACHED' }, showError: value => { message = value; } });
    vm.runInContext('(function(){' + source.slice(start, end) + '})()', context);
    assert.equal(message, 'Il limite giornaliero della beta è stato raggiunto. Riprova domani.');
  });
  console.log(`PASS: ${pass}\nFAIL: ${fail}\nSKIPPED: 0`);
}
main().catch(error => { fail++; console.error(error); }).finally(() => {
  global.Date = originalDate; console.warn = warn; database.db.close();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('global-beta-cap-')) throw new Error('Unsafe cleanup');
  fs.rmSync(directory, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
});
