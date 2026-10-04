#!/usr/bin/env node
/**
 * CSV formula-injection regression test.
 * - Real Express app + real /api/export/csv and /api/export/xlsx routes.
 * - Isolated temp DB (TEST_DB_PATH); provider credentials are BLANKED after
 *   the app's dotenv load is neutralised (set to '' before require, so
 *   dotenv cannot overwrite them) and any non-local network call is blocked.
 * Run: node test/csv-export.test.js
 */
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-export-test-'));
Object.assign(process.env, {
  TEST_DB_PATH: path.join(tmpDir, 'csv.sqlite'), NODE_ENV: 'test', PORT: '34650', LAUNCH_MODE: 'waitlist',
  SESSION_SECRET: 'csv-test-secret-csv-test-secret-1234567', TEST_MODE: 'false',
  ANTHROPIC_API_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', RESEND_API_KEY: '',
  RATE_LIMIT_MAX_REQUESTS: '100000',
});

const outbound = [];
const origFetch = global.fetch;
global.fetch = (u, ...a) => {
  if (!/^(https?:\/\/)?(127\.0\.0\.1|localhost)/.test(String(u && u.url ? u.url : u))) { outbound.push(String(u)); return Promise.reject(new Error('blocked')); }
  return origFetch(u, ...a);
};
for (const m of ['request', 'get']) https[m] = () => { outbound.push('https.' + m); throw new Error('blocked'); };

const writes = [];
for (const n of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream']) {
  const o = fs[n]; fs[n] = function (p, ...a) { writes.push(n + ':' + p); return o.call(this, p, ...a); };
}

require(path.join(ROOT, 'src/server.js'));
const ExcelJS = require('exceljs');
const { generateCsv, neutralizeFormula } = require(path.join(ROOT, 'src/services/excelService'));

function post(p, obj) {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify(obj);
    const r = http.request({ host: '127.0.0.1', port: 34650, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(ch) }));
    });
    r.on('error', reject); r.write(b); r.end();
  });
}

// RFC4180-style parser for ';' delimiter, honouring quotes and newlines in quotes.
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ';') { row.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  row.push(cell); rows.push(row); return rows;
}
const TEXT_COLS = [0, 1, 2, 3];       // File Origine, Fornitore, N. Fattura, Data
const NUM_COLS = [4, 5, 6];           // Imponibile, IVA, Totale
const DANGEROUS = /^[\u0000-  ​﻿]*[=+\-@]|^[\t\r\n]/;

async function csvFor(rows) {
  const r = await post('/api/export/csv', { rows });
  assert.strictEqual(r.status, 200);
  const text = r.buf.toString('utf8');
  const parsed = parseCsv(text.replace(/^﻿/, ''));
  const h = parsed.findIndex((x) => x[0] === 'File Origine');
  return { text, parsed, header: parsed[h], data: parsed.slice(h + 1).filter((x) => x.length > 1) };
}
const base = (o) => ({ source_file: 'f.pdf', supplier: 'ACME S.r.l.', invoice_number: 'INV-2026-001', date: '2026-01-01', subtotal: 100, vat_amount: 22, total: 122, currency: 'EUR', ...o });

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('PASS: ' + name); pass++; } catch (e) { console.log('FAIL: ' + name + '\n  ' + e.message); fail++; }
}

async function main() {
  await new Promise((r) => setTimeout(r, 300));
  const attacks = [
    ['T1 =HYPERLINK', '=HYPERLINK("https://example.com","click")'],
    ['T2 +SUM', '+SUM(1,1)'],
    ['T3 -1+2 as TEXT field', '-1+2'],
    ['T4 @SUM', '@SUM(1,1)'],
    ['T5 leading spaces + =', '   =HYPERLINK("https://example.com","x")'],
    ['T6a leading tab + =', '\t=cmd|\' /C calc\'!A0'],
    ['T6b leading CR', '\r=1+1'],
    ['T6c leading NBSP + @', ' @SUM(1,1)'],
    ['T6d leading tab then ordinary text', '\tordinary'],
  ];
  for (const [name, evil] of attacks) {
    await t(`${name}: every text cell in FINAL CSV is non-executable, content preserved`, async () => {
      const out = await csvFor([base({ supplier: evil, invoice_number: evil, source_file: evil })]);
      const cells = out.data[0];
      for (const i of TEXT_COLS.slice(0, 3)) {
        assert.ok(!DANGEROUS.test(cells[i]), `col ${i} still executable: ${JSON.stringify(cells[i])}`);
        assert.ok(cells[i].endsWith(evil) && cells[i] === "'" + evil, `content not preserved: ${JSON.stringify(cells[i])}`);
      }
    });
  }
  await t('T3b quoting alone is not relied upon: raw CSV never has a cell starting with "= or "+ or "- or "@', async () => {
    const out = await csvFor([base({ supplier: '=1+1;x', invoice_number: '@a"b' })]);
    assert.ok(!/(^|;)"?[=+\-@]/.test(out.text.split('\r\n').find((l) => l.startsWith('f.pdf'))), 'raw line has formula-leading cell');
  });
  await t('T7 ordinary supplier preserved exactly', async () => { assert.strictEqual((await csvFor([base({})])).data[0][1], 'ACME S.r.l.'); });
  await t('T8 ordinary invoice number preserved exactly', async () => { assert.strictEqual((await csvFor([base({})])).data[0][2], 'INV-2026-001'); });
  await t('T9 semicolon in text is quoted and round-trips', async () => {
    const out = await csvFor([base({ supplier: 'Rossi; Bianchi' })]);
    assert.strictEqual(out.data[0][1], 'Rossi; Bianchi'); assert.ok(out.text.includes('"Rossi; Bianchi"'));
  });
  await t('T10 double quote is escaped and round-trips', async () => {
    const out = await csvFor([base({ supplier: 'Say "hi" Srl' })]);
    assert.strictEqual(out.data[0][1], 'Say "hi" Srl'); assert.ok(out.text.includes('"Say ""hi"" Srl"'));
  });
  await t('T11 newline in text is quoted and round-trips', async () => {
    const out = await csvFor([base({ supplier: 'Line1\nLine2' })]);
    assert.strictEqual(out.data[0][1], 'Line1\nLine2');
  });
  await t('T11b dangerous prefix AND quote/semicolon together: neutralised then escaped', async () => {
    const out = await csvFor([base({ supplier: '=A1;"x"' })]);
    assert.strictEqual(out.data[0][1], "'=A1;\"x\"");
  });
  await t('T12 negative NUMERIC accounting values stay plain numbers (no apostrophe), math still OK', async () => {
    const out = await csvFor([base({ subtotal: -123.45, vat_amount: -27.16, total: -150.61 })]);
    const c = out.data[0];
    assert.deepStrictEqual([c[4], c[5], c[6]], ['-123.45', '-27.16', '-150.61']);
    assert.ok(c.includes('OK'));
  });
  await t('T12b numeric strings with comma decimals still numeric', async () => {
    const out = await csvFor([base({ subtotal: '-100,50', vat_amount: 0, total: '-100,50' })]);
    assert.deepStrictEqual([out.data[0][4], out.data[0][6]], ['-100.50', '-100.50']);
  });
  await t('T13 delimiter remains ";" (header has 8+ ;-separated columns)', async () => {
    const out = await csvFor([base({})]); assert.ok(out.header.length >= 8 && out.header[0] === 'File Origine' && out.header[4] === 'Imponibile');
  });
  await t('T14 UTF-8 BOM unchanged', async () => { assert.strictEqual((await csvFor([base({})])).text.charCodeAt(0), 0xFEFF); });
  await t('T15 XLSX unchanged: injected text stays a plain string WITHOUT apostrophe', async () => {
    const r = await post('/api/export/xlsx', { rows: [base({ supplier: '=HYPERLINK("https://example.com","x")' })] });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.buf);
    const cell = wb.getWorksheet('Fatture Estratte').getRow(6).getCell(2);
    assert.strictEqual(cell.type, ExcelJS.ValueType.String);
    assert.strictEqual(cell.value, '=HYPERLINK("https://example.com","x")');
  });
  await t('T16 independent math verification unchanged (client flag ignored; mismatch flagged)', async () => {
    const out = await csvFor([base({ math_verified: true }), base({ total: 130, math_verified: true })]);
    assert.ok(out.data[0].includes('OK')); assert.ok(out.data[1].includes('Da verificare'));
  });
  await t('T16b blank/failed row exports blank amounts and Da verificare', async () => {
    const out = await csvFor([{ source_file: 'failed.pdf', supplier: '', subtotal: null, vat_amount: null, total: null }]);
    assert.deepStrictEqual(out.data[0].slice(0, 8), ['failed.pdf', '', '', '', '', '', '', 'Da verificare']);
  });
  await t('T16c unit: neutralizeFormula handles null/numbers/empty', async () => {
    assert.strictEqual(neutralizeFormula(null), null); assert.strictEqual(neutralizeFormula(''), ''); assert.strictEqual(neutralizeFormula(42), '42');
    assert.strictEqual(neutralizeFormula('a=b'), 'a=b'); assert.strictEqual(neutralizeFormula('2026-01-01'), '2026-01-01');
  });
  await t('T16d direct service call (no HTTP) also neutralises', async () => {
    const csv = generateCsv([{ source_file: 'x', supplier: '=1+1', invoice_number: 'i', date: 'd', subtotal: 1, vat_amount: 0, total: 1, currency: 'EUR' }]);
    assert.ok(csv.includes("'=1+1") && !/(^|;)=1\+1/m.test(csv));
  });
  await t('T17 zero-retention: no fs writes during exports; excelService has no write APIs', async () => {
    const before = writes.length; await csvFor([base({ supplier: '=x' })]); await post('/api/export/xlsx', { rows: [base({})] });
    assert.strictEqual(writes.length, before, 'fs writes: ' + JSON.stringify(writes.slice(before)));
    assert.ok(!/writeFile|createWriteStream|appendFile/.test(fs.readFileSync(path.join(ROOT, 'src/services/excelService.js'), 'utf8')));
  });
  await t('T18 no outbound network attempts (Anthropic/Stripe/Resend/any)', async () => { assert.deepStrictEqual(outbound, []); });

  try { require(path.join(ROOT, 'src/services/database')).db.close(); } catch (e) { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log(`\nPASS: ${pass}  FAIL: ${fail}  TOTAL: ${pass + fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
