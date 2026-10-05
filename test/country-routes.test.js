#!/usr/bin/env node
/**
 * Localized routes + document country over real HTTP (offline).
 *
 * Runs the REAL Express app with claudeService stubbed in the module cache
 * (no provider call possible), an isolated temp SQLite DB and no provider
 * keys. Verifies SEO routes, /api/config country data, the country_code
 * wiring into the extraction layer, backward compatibility of the upload
 * flow, and that a rejected country does not consume quota.
 *
 * Run: node test/country-routes.test.js
 */
require('./helpers/offline');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'country-routes-'));
const PORT = 34811;
Object.assign(process.env, {
  TEST_DB_PATH: path.join(tmpDir, 'country.sqlite'),
  NODE_ENV: 'test',
  LAUNCH_MODE: 'waitlist',
  SESSION_SECRET: 'test-only-session-secret-32-characters-minimum-xx',
  PORT: String(PORT),
  FRONTEND_URL: 'https://invoiceextract.example',
});
delete process.env.TEST_MODE;

const claudePath = require.resolve(path.join(ROOT, 'src/services/claudeService'));
const calls = [];
let mockCurrency = 'EUR';
require.cache[claudePath] = {
  id: claudePath, filename: claudePath, loaded: true,
  exports: {
    extractInvoiceData: async (buffer, mimetype, filename, options) => {
      calls.push({ filename, options });
      return {
        records: [{
          source_file: filename, supplier: 'Mock', invoice_number: 'M-1', date: '2026-01-01',
          subtotal: 100, vat_amount: 22, total: 122, currency: mockCurrency, math_verified: true,
          ...(options && options.countryCode ? { country_code: options.countryCode } : {}),
        }],
        truncated: false, extractedCount: 1,
      };
    },
  },
};

require(path.join(ROOT, 'src/server.js'));
const stripeService = require(path.join(ROOT, 'src/services/stripeService'));
const { PDFDocument } = require('pdf-lib');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS: ' + name); pass++; }
  catch (e) { console.log('FAIL: ' + name + '\n  ' + e.message); fail++; }
}

function get(p, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });
}

async function pdf() {
  const doc = await PDFDocument.create();
  doc.addPage();
  return Buffer.from(await doc.save());
}

let userCounter = 0;
const newUser = () => 'usr_country00-0000-0000-0000-' + String(++userCounter).padStart(12, '0');

function postExtract(userId, fileBuffer, fields = {}) {
  return new Promise((resolve, reject) => {
    const boundary = '----CountryBoundary' + Math.random().toString(16).slice(2);
    const chunks = [];
    for (const [k, v] of Object.entries(fields)) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="invoices"; filename="f.pdf"\r\nContent-Type: application/pdf\r\n\r\n`));
    chunks.push(fileBuffer, Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(chunks);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/extract', method: 'POST',
      headers: { 'X-User-Id': userId, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const file = await pdf();

  await test('localized routes: /it/ is SEO-exposed, other locales technically served but noindex -> canonical /it/', async () => {
    for (const l of ['it', 'en', 'fr', 'de', 'es', 'pt']) {
      for (const p of [`/${l}/`, `/${l}`]) {
        const r = await get(p);
        assert.strictEqual(r.status, 200, p);
        assert.ok(/text\/html/.test(r.headers['content-type']));
        assert.ok(r.body.includes('<html lang="it">'), p); // contenuto principale italiano
        assert.ok(r.body.includes('<link rel="canonical" href="https://invoiceextract.example/it/" />'), p);
        if (l === 'it') {
          assert.ok(r.body.includes('hreflang="x-default"') && !/noindex/.test(r.body), p);
        } else {
          assert.ok(r.body.includes('<meta name="robots" content="noindex,follow" />'), p);
          assert.ok(!/hreflang=/.test(r.body), p);
        }
      }
    }
  });

  await test('SEO URLs use FRONTEND_URL, never the request Host header', async () => {
    const r = await get('/it/', { Host: 'evil.example' });
    assert.ok(!r.body.includes('evil.example'));
    assert.ok(r.body.includes('https://invoiceextract.example/it/'));
  });

  await test('root "/" still serves the app (default locale, canonical to /it/)', async () => {
    const r = await get('/');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('id="drop-zone"'));
    assert.ok(r.body.includes('<html lang="it">'));
    assert.ok(r.body.includes('rel="canonical" href="https://invoiceextract.example/it/"'));
  });

  await test('unknown / uppercase locale paths are not served as the app', async () => {
    for (const p of ['/xx/', '/IT/', '/admin']) {
      const r = await get(p);
      assert.strictEqual(r.status, 404, p);
    }
  });

  await test('static assets and legal pages unaffected', async () => {
    for (const p of ['/app.js', '/i18n.js', '/intl.js', '/dist/styles.css', '/legal/terms.html', '/index.html']) {
      assert.strictEqual((await get(p)).status, 200, p);
    }
    const health = await get('/api/health');
    assert.strictEqual(health.status, 200);
  });

  await test('/api/config exposes centralized countries + locales, no secrets', async () => {
    const cfg = JSON.parse((await get('/api/config')).body);
    assert.strictEqual(cfg.defaultCountryCode, 'IT');
    assert.deepStrictEqual(cfg.locales, ['it', 'en', 'fr', 'de', 'es', 'pt']);
    const byCode = Object.fromEntries(cfg.countries.map((c) => [c.code, c]));
    assert.strictEqual(byCode.IT.supportStatus, 'SUPPORTED');
    assert.strictEqual(byCode.US.supportStatus, 'COMING_SOON');
    const enabled = Object.fromEntries(cfg.countries.map((c) => [c.code, c.enabledForExtraction]));
    assert.deepStrictEqual(enabled, { IT: true, FR: false, DE: false, ES: false, PT: false, US: false });
    for (const c of ['FR', 'DE', 'ES', 'PT']) assert.strictEqual(byCode[c].supportStatus, 'BETA', c);
    assert.deepStrictEqual(cfg.countries.filter((c) => c.supportStatus === 'SUPPORTED').map((c) => c.code), ['IT']);
    assert.strictEqual(cfg.maxFileSizeMb, 10); // legacy keys still present
    assert.ok('launchMode' in cfg && 'testMode' in cfg);
  });

  await test('extract WITHOUT country_code: legacy behavior, defaults to IT', async () => {
    calls.length = 0;
    const r = await postExtract(newUser(), file);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.results.length, 1);
    assert.strictEqual(r.body.results[0].supplier, 'Mock');
    assert.strictEqual(r.body.pagesProcessed, 1);
    assert.deepStrictEqual(calls[0].options, { countryCode: 'IT' });
  });

  await test('extract with country_code=IT (explicit, any case) reaches the provider layer', async () => {
    calls.length = 0;
    const r = await postExtract(newUser(), file, { country_code: 'it' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(calls[0].options, { countryCode: 'IT' });
    assert.strictEqual(r.body.results[0].country_code, 'IT');
  });

  await test('currency independent from country: IT document in USD stays USD', async () => {
    mockCurrency = 'USD';
    const it = await postExtract(newUser(), file, { country_code: 'IT' });
    assert.strictEqual(it.body.results[0].currency, 'USD');
    mockCurrency = 'EUR';
    mockCurrency = 'EUR';
  });

  await test('FR/DE/ES/PT/US rejected before quota and before provider (400 COUNTRY_NOT_AVAILABLE)', async () => {
    const user = newUser();
    calls.length = 0;
    const before = stripeService.getPlanStatus(user).used;
    // un utente per richiesta: extractLimiter ammette 3 richieste/minuto per utente
    // (quota verificata sull'utente di riferimento, mai toccata dai rifiuti)
    for (const code of ['FR', 'DE', 'ES', 'PT', 'US', 'fr', ' de ']) {
      const u = newUser();
      const usedBefore = stripeService.getPlanStatus(u).used;
      const r = await postExtract(u, file, { country_code: code });
      assert.strictEqual(r.status, 400, code);
      assert.strictEqual(r.body.code, 'COUNTRY_NOT_AVAILABLE', code);
      assert.strictEqual(stripeService.getPlanStatus(u).used, usedBefore, `${code} consumed quota`);
      assert.ok(typeof r.body.error === 'string' && !/stack|at \w+ \(/i.test(r.body.error), code);
    }
    assert.strictEqual(calls.length, 0, 'zero provider calls');
    assert.strictEqual(stripeService.getPlanStatus(user).used, before, 'zero quota consumed');
  });

  await test('invalid country_code rejected with 400, no quota, no provider call', async () => {
    const user = newUser();
    calls.length = 0;
    const before = stripeService.getPlanStatus(user).used;
    for (const code of ['XX', 'constructor', '__proto__', '<script>']) {
      const u = newUser();
      const usedBefore = stripeService.getPlanStatus(u).used;
      const bad = await postExtract(u, file, { country_code: code });
      assert.strictEqual(stripeService.getPlanStatus(u).used, usedBefore, `${code} consumed quota`);
      assert.strictEqual(bad.status, 400, code);
      assert.strictEqual(bad.body.code, 'INVALID_COUNTRY_CODE', code);
    }
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(stripeService.getPlanStatus(user).used, before);
  });

  await test('after rejected countries, IT extraction still works and consumes quota once', async () => {
    const user = newUser();
    assert.strictEqual((await postExtract(user, file, { country_code: 'DE' })).status, 400);
    const before = stripeService.getPlanStatus(user).used;
    const ok = await postExtract(user, file, { country_code: 'IT' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(stripeService.getPlanStatus(user).used, before + 1);
  });

  await test('language is not a request input: lang/Accept-Language never changes the country', async () => {
    calls.length = 0;
    await new Promise((resolve, reject) => {
      const boundary = '----L' + Math.random().toString(16).slice(2);
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="lang"\r\n\r\nde\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="invoices"; filename="f.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
        file, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const req = http.request({
        host: '127.0.0.1', port: PORT, path: '/api/extract', method: 'POST',
        headers: { 'X-User-Id': newUser(), 'Accept-Language': 'de-DE,de;q=0.9', 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end(body);
    });
    assert.deepStrictEqual(calls[0].options, { countryCode: 'IT' });
  });

  await test('upload validation unchanged: request without file => 400', async () => {
    const user = newUser();
    const boundary = '----E' + Math.random().toString(16).slice(2);
    const empty = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="country_code"\r\n\r\nIT\r\n--${boundary}--\r\n`);
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: PORT, path: '/api/extract', method: 'POST',
        headers: { 'X-User-Id': user, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': empty.length },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end(empty);
    });
    assert.strictEqual(status, 400);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL: ' + e.stack); process.exit(1); });
