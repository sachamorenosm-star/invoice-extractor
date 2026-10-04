// Mobile image integrity: limits from /api/config, real decode, resolution, JPEG re-encode without EXIF,
// preview "Usa foto / Rifai", row errors, OK / CHECK / UNREADABLE and toast semantics. Offline, no provider.
// Node has no browser image APIs, so decode/canvas/encode are deterministic stubs injected into the real modules;
// the actual browser behaviour (decode, EXIF removal) is verified separately in a real browser.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const Quality = require('../public/uploadQuality');
const Intake = require('../public/imageIntake');

let pass = 0, fail = 0;
const out = (message) => fs.writeSync(1, message + '\n');
async function test(name, fn) {
  try { await fn(); pass++; out('PASS: ' + name); }
  catch (error) { fail++; out('FAIL: ' + name + ' ' + error.message); }
}

const ACCEPTED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const MB = 1024 * 1024;
const EXIF_MARKER = 'GPSLatitude-45.4642-DeviceModel-PhoneX-2026:10:05';

// ---- synthetic images ------------------------------------------------------------------
function jpeg({ width, height, exif = true, pad = 0, truncated = false }) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (exif) {
    const body = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from(EXIF_MARKER)]);
    parts.push(Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body);
  }
  parts.push(Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]));
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), Buffer.alloc(pad, 0x41));
  if (!truncated) parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}
function png({ width, height, truncated = false }) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const chunk = (type, data) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]); };
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.alloc(64, 7))];
  if (!truncated) parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
const file = (bytes, name, type) => new File([bytes], name, { type });

// Header-based decoder: rejects anything that is not a structurally complete JPEG/PNG.
function decodeStub(bytes) {
  const b = Buffer.from(bytes);
  if (b.length > 12 && b[0] === 0x89 && b.slice(1, 4).toString() === 'PNG') {
    if (!b.slice(-12).includes(Buffer.from('IEND'))) throw Object.assign(new Error('corrupt png'), { name: 'InvalidStateError' });
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) throw Object.assign(new Error('corrupt jpeg'), { name: 'InvalidStateError' });
    for (let i = 2; i < b.length - 9; i++) if (b[i] === 0xff && (b[i + 1] === 0xc0 || b[i + 1] === 0xc2)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
  }
  throw Object.assign(new Error('not an image'), { name: 'InvalidStateError' });
}
// Deterministic stand-ins for the browser APIs; encoded size grows with pixels and quality.
function makeDeps({ rejectOptions = false } = {}) {
  const log = { closed: 0, draws: 0, encodes: [], optionCalls: 0 };
  return {
    log,
    createImageBitmap: async (blob, options) => {
      if (options) { log.optionCalls++; if (rejectOptions) throw new TypeError('unsupported imageOrientation'); }
      const { width, height } = decodeStub(await blob.arrayBuffer());
      return { width, height, close() { log.closed++; } };
    },
    createCanvas: (width, height) => ({ width, height, getContext: () => ({ fillRect() {}, drawImage() { log.draws++; }, set fillStyle(_) {} }) }),
    canvasToBlob: async (canvas, type, quality) => {
      log.encodes.push({ width: canvas.width, height: canvas.height, quality });
      const fresh = jpeg({ width: canvas.width, height: canvas.height, exif: false, pad: Math.round(canvas.width * canvas.height * quality * 0.5) });
      return new Blob([fresh], { type });
    },
    File,
    now: () => 1700000000000,
  };
}
function makeHarness({ queue = [], max = 3, maxMb = 5, rejectOptions = false } = {}) {
  const calls = { added: [], previews: [], hidden: 0, errors: [], reopened: [] };
  const deps = makeDeps({ rejectOptions });
  const limits = { maxFileSizeMb: maxMb, maxFilesPerRequest: max };
  const intake = Intake.createIntake({
    deps, acceptedTypes: ACCEPTED, getLimits: () => limits, getQueueSize: () => queue.length,
    addFile: (f, quality) => { queue.push(f); calls.added.push({ file: f, quality }); },
    showPreview: (item) => calls.previews.push(item), hidePreview: () => { calls.hidden++; },
    showErrors: (messages) => calls.errors.push(...messages), reopenPicker: (source) => calls.reopened.push(source),
  });
  return { intake, calls, deps, limits, queue };
}

// ---- real app.js code ------------------------------------------------------------------
const appSource = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
function sliceApp(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker); const end = appSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'marker not found: ' + startMarker);
  return appSource.slice(start, end);
}

async function main() {
  // ============ limits from /api/config ============
  await test('real fetchConfig copies maxFileSizeMb and maxFilesPerRequest from /api/config into the client limits', async () => {
    const context = vm.createContext({
      limits: { maxFileSizeMb: 10, maxFilesPerRequest: 10 }, els: { maxSizeLabel: {} }, state: {}, launchMode: 'waitlist',
      applyLaunchModeUi() {}, updateBetaBannerUi() {}, hideBetaBanner() {},
      fetch: async () => ({ ok: true, json: async () => ({ maxFileSizeMb: 5, maxFilesPerRequest: 3, launchMode: 'waitlist', testMode: true, testDailyLimit: 20 }) }),
    });
    vm.runInContext(sliceApp('  async function fetchConfig() {', '  function updateBetaBannerUi') + '\nfetchConfig.__run = fetchConfig;', context);
    await context.fetchConfig();
    assert.strictEqual(context.limits.maxFileSizeMb, 5); assert.strictEqual(context.limits.maxFilesPerRequest, 3);
    assert.strictEqual(context.els.maxSizeLabel.textContent, 5);
  });
  await test('invalid /api/config values never replace the limits', async () => {
    const context = vm.createContext({
      limits: { maxFileSizeMb: 10, maxFilesPerRequest: 10 }, els: { maxSizeLabel: {} }, state: {}, launchMode: 'waitlist',
      applyLaunchModeUi() {}, updateBetaBannerUi() {}, hideBetaBanner() {},
      fetch: async () => ({ ok: true, json: async () => ({ maxFileSizeMb: 'abc', maxFilesPerRequest: -1 }) }),
    });
    vm.runInContext(sliceApp('  async function fetchConfig() {', '  function updateBetaBannerUi'), context);
    await context.fetchConfig();
    assert.strictEqual(context.limits.maxFileSizeMb, 10); assert.strictEqual(context.limits.maxFilesPerRequest, 10);
  });
  await test('no hardcoded 10 MB client constant remains in app.js', () => {
    assert.ok(!/MAX_FILE_SIZE_MB/.test(appSource)); assert.ok(appSource.includes('limits.maxFileSizeMb = data.maxFileSizeMb'));
  });
  await test('maxFileSizeMb is enforced for PDFs (6 MB rejected at 5 MB, accepted at 10 MB)', async () => {
    const big = file(Buffer.alloc(6 * MB), 'grande.pdf', 'application/pdf');
    const strict = makeHarness({ maxMb: 5 }); await strict.intake.handle([big], 'file');
    assert.strictEqual(strict.calls.added.length, 0); assert.match(strict.calls.errors[0], /supera il limite di 5 MB/);
    const loose = makeHarness({ maxMb: 10 }); await loose.intake.handle([big], 'file');
    assert.strictEqual(loose.calls.added.length, 1);
  });
  await test('maxFilesPerRequest is enforced including files already queued', async () => {
    const h = makeHarness({ max: 3, queue: [{}, {}] });
    const pdf = () => file(Buffer.from('%PDF-1.4'), 'a.pdf', 'application/pdf');
    await h.intake.handle([pdf(), pdf()], 'file');
    assert.strictEqual(h.calls.added.length, 1); assert.match(h.calls.errors.join(' '), /al massimo 3 file/);
  });
  await test('a 7 MB phone photo is accepted and shrunk under the 5 MB server limit', async () => {
    const h = makeHarness({ maxMb: 5 });
    await h.intake.handle([file(jpeg({ width: 4000, height: 3000, pad: 7 * MB }), 'IMG_0001.jpg', 'image/jpeg')], 'file');
    assert.strictEqual(h.calls.added.length, 1); assert.ok(h.calls.added[0].file.size <= 5 * MB);
    assert.strictEqual(Math.max(h.deps.log.encodes[0].width, h.deps.log.encodes[0].height), 2000);
  });
  await test('an image that cannot fit the limit even after reduction is rejected with a clear message', async () => {
    const h = makeHarness({ maxMb: 0.01 });
    await h.intake.handle([file(jpeg({ width: 3000, height: 2000, pad: 10 }), 'pesante.jpg', 'image/jpeg')], 'file');
    assert.strictEqual(h.calls.added.length, 0); assert.match(h.calls.errors[0], /troppo pesante anche dopo la riduzione/);
  });

  // ============ decode validation ============
  await test('corrupt JPEG is rejected before upload, with a clear message', async () => {
    const h = makeHarness();
    await h.intake.handle([file(jpeg({ width: 3000, height: 2000, truncated: true }), 'rotta.jpg', 'image/jpeg')], 'file');
    assert.strictEqual(h.calls.added.length, 0); assert.match(h.calls.errors[0], /non può essere letta/);
  });
  await test('corrupt PNG is rejected before upload', async () => {
    const h = makeHarness();
    await h.intake.handle([file(png({ width: 3000, height: 2000, truncated: true }), 'rotta.png', 'image/png')], 'file');
    assert.strictEqual(h.calls.added.length, 0); assert.match(h.calls.errors[0], /non può essere letta/);
  });
  await test('random bytes labelled as image/jpeg are rejected (MIME is not trusted)', async () => {
    const h = makeHarness();
    await h.intake.handle([file(Buffer.from('<html>not an image</html>'), 'finta.jpg', 'image/jpeg')], 'file');
    assert.strictEqual(h.calls.added.length, 0); assert.strictEqual(h.calls.errors.length, 1);
  });
  await test('valid JPEG is decoded and accepted as a fresh image/jpeg file', async () => {
    const h = makeHarness();
    await h.intake.handle([file(jpeg({ width: 3000, height: 2000 }), 'fattura.jpg', 'image/jpeg')], 'file');
    assert.strictEqual(h.calls.errors.length, 0); assert.strictEqual(h.calls.added.length, 1);
    assert.strictEqual(h.calls.added[0].file.type, 'image/jpeg'); assert.strictEqual(h.calls.added[0].file.name, 'fattura.jpg');
    assert.strictEqual(h.calls.added[0].quality.level, 'ok'); assert.ok(h.deps.log.closed >= 1, 'decoded bitmap must be released');
  });
  await test('valid PNG becomes a JPEG named .jpg', async () => {
    const h = makeHarness();
    await h.intake.handle([file(png({ width: 2400, height: 1600 }), 'scansione.png', 'image/png')], 'file');
    assert.strictEqual(h.calls.added[0].file.name, 'scansione.jpg'); assert.strictEqual(h.calls.added[0].file.type, 'image/jpeg');
  });
  await test('browsers that reject the orientation option still decode (retry without options)', async () => {
    const h = makeHarness({ rejectOptions: true });
    await h.intake.handle([file(jpeg({ width: 3000, height: 2000 }), 'a.jpg', 'image/jpeg')], 'file');
    assert.strictEqual(h.calls.added.length, 1); assert.ok(h.deps.log.optionCalls >= 1);
  });
  await test('orientation is requested from the image (imageOrientation: from-image)', () => {
    assert.ok(fs.readFileSync(path.join(ROOT, 'public/imageIntake.js'), 'utf8').includes("imageOrientation: 'from-image'"));
  });

  // ============ resolution ============
  await test('tiny image is hard-rejected (below the minimum edges)', async () => {
    for (const [w, h] of [[300, 200], [450, 300], [4000, 150]]) {
      const x = makeHarness();
      await x.intake.handle([file(png({ width: w, height: h }), 'mini.png', 'image/png')], 'file');
      assert.strictEqual(x.calls.added.length, 0, `${w}x${h}`); assert.match(x.calls.errors[0], /troppo piccola/);
    }
  });
  await test('marginal resolution is accepted but marked CHECK with a warning', async () => {
    const h = makeHarness();
    await h.intake.handle([file(jpeg({ width: 900, height: 700 }), 'bassa.jpg', 'image/jpeg')], 'file');
    assert.strictEqual(h.calls.added.length, 1); assert.strictEqual(h.calls.added[0].quality.level, 'check');
    assert.match(h.calls.added[0].quality.reasons[0], /Risoluzione bassa/);
  });
  await test('documented thresholds: 500 px hard / 1000 px warning (long edge), 200 px short edge', () => {
    assert.strictEqual(Intake.THRESHOLDS.hardMinLongEdge, 500); assert.strictEqual(Intake.THRESHOLDS.warnMinLongEdge, 1000);
    assert.strictEqual(Intake.THRESHOLDS.hardMinShortEdge, 200); assert.ok(Object.isFrozen(Intake.THRESHOLDS));
  });

  // ============ re-encoding / privacy ============
  await test('processed image is a NEW binary: differs from the original and carries no EXIF/GPS marker', async () => {
    const original = jpeg({ width: 3000, height: 2000, pad: 2000 });
    assert.ok(original.includes(Buffer.from('Exif')) && original.includes(Buffer.from(EXIF_MARKER)), 'fixture must contain EXIF');
    const h = makeHarness();
    await h.intake.handle([file(original, 'IMG_1.jpg', 'image/jpeg')], 'file');
    const out = Buffer.from(await h.calls.added[0].file.arrayBuffer());
    assert.ok(!out.equals(original)); assert.ok(!out.includes(Buffer.from('Exif'))); assert.ok(!out.includes(Buffer.from(EXIF_MARKER)));
    assert.ok(h.deps.log.draws >= 1 && h.deps.log.encodes.length >= 1, 'the image must go through canvas re-encoding');
  });
  await test('large photos are reduced to the maximum long edge without upscaling small ones', async () => {
    const big = makeHarness(); await big.intake.handle([file(jpeg({ width: 6000, height: 4000 }), 'g.jpg', 'image/jpeg')], 'file');
    assert.deepStrictEqual([big.deps.log.encodes[0].width, big.deps.log.encodes[0].height], [2000, 1333]);
    const small = makeHarness(); await small.intake.handle([file(jpeg({ width: 1500, height: 1000 }), 'p.jpg', 'image/jpeg')], 'file');
    assert.deepStrictEqual([small.deps.log.encodes[0].width, small.deps.log.encodes[0].height], [1500, 1000]);
  });
  await test('JPEG quality never drops below 0.7 (invoice text is preserved)', () => {
    assert.ok(Math.min(...Intake.THRESHOLDS.jpegQualities) >= 0.7);
  });

  // ============ preview / retake ============
  await test('camera photo shows a preview first and is NOT queued yet', async () => {
    const h = makeHarness();
    await h.intake.handle([file(jpeg({ width: 3000, height: 2000 }), 'camera.jpg', 'image/jpeg')], 'camera');
    assert.strictEqual(h.calls.previews.length, 1); assert.strictEqual(h.calls.added.length, 0);
    assert.strictEqual(h.calls.previews[0].quality.level, 'ok'); assert.strictEqual(h.calls.previews[0].source, 'camera');
  });
  await test('"Rifai" does not add the file, closes the preview and reopens the camera', async () => {
    const h = makeHarness();
    await h.intake.handle([file(jpeg({ width: 3000, height: 2000 }), 'camera.jpg', 'image/jpeg')], 'camera');
    h.intake.retake();
    assert.strictEqual(h.calls.added.length, 0); assert.deepStrictEqual(h.calls.reopened, ['camera']); assert.ok(h.calls.hidden >= 1);
    assert.ok(h.deps.log.closed >= 1);
  });
  await test('"Usa foto" adds the PROCESSED file (not the original) and closes the preview', async () => {
    const original = jpeg({ width: 3000, height: 2000, pad: 500 });
    const h = makeHarness();
    await h.intake.handle([file(original, 'camera.jpg', 'image/jpeg')], 'camera');
    h.intake.use();
    assert.strictEqual(h.calls.added.length, 1); assert.strictEqual(h.calls.reopened.length, 0); assert.ok(h.calls.hidden >= 1);
    const out = Buffer.from(await h.calls.added[0].file.arrayBuffer());
    assert.ok(!out.equals(original) && !out.includes(Buffer.from(EXIF_MARKER)));
  });
  await test('gallery with several photos previews one at a time; the last "Scegli un\'altra" reopens the gallery', async () => {
    const h = makeHarness();
    await h.intake.handle([file(jpeg({ width: 3000, height: 2000 }), 'a.jpg', 'image/jpeg'), file(jpeg({ width: 2800, height: 2000 }), 'b.jpg', 'image/jpeg')], 'gallery');
    assert.strictEqual(h.calls.previews.length, 1); assert.strictEqual(h.calls.previews[0].file.name, 'a.jpg');
    h.intake.use(); assert.strictEqual(h.calls.previews.length, 2); assert.strictEqual(h.calls.previews[1].file.name, 'b.jpg');
    h.intake.retake();
    assert.deepStrictEqual(h.calls.added.map((a) => a.file.name), ['a.jpg']); assert.deepStrictEqual(h.calls.reopened, ['gallery']);
  });
  await test('marginal camera photo previews as CHECK with the reason', async () => {
    const h = makeHarness();
    await h.intake.handle([file(jpeg({ width: 900, height: 700 }), 'bassa.jpg', 'image/jpeg')], 'camera');
    assert.strictEqual(h.calls.previews[0].quality.level, 'check'); assert.match(h.calls.previews[0].quality.reasons[0], /Risoluzione bassa/);
  });
  await test('file picker, drag/drop and paste images are validated and re-encoded WITHOUT a preview', async () => {
    for (const source of ['file', 'drop', 'paste']) {
      const h = makeHarness();
      await h.intake.handle([file(jpeg({ width: 3000, height: 2000 }), 'x.jpg', 'image/jpeg')], source);
      assert.strictEqual(h.calls.previews.length, 0, source); assert.strictEqual(h.calls.added.length, 1, source);
    }
  });
  await test('using a photo when the queue is already full is refused with the limit message', async () => {
    const h = makeHarness({ max: 3 });
    await h.intake.handle([file(jpeg({ width: 3000, height: 2000 }), 'c.jpg', 'image/jpeg')], 'camera');
    h.queue.push({}, {}, {}); h.intake.use();
    assert.strictEqual(h.calls.added.length, 0); assert.match(h.calls.errors.join(' '), /al massimo 3 file/);
  });

  // ============ PDF flow unchanged ============
  await test('PDF is queued as the same File object, never decoded or re-encoded', async () => {
    const h = makeHarness(); const pdf = file(Buffer.from('%PDF-1.4 test'), 'f.pdf', 'application/pdf');
    await h.intake.handle([pdf], 'camera');
    assert.strictEqual(h.calls.added[0].file, pdf); assert.strictEqual(h.calls.added[0].quality, null);
    assert.strictEqual(h.deps.log.encodes.length, 0); assert.strictEqual(h.calls.previews.length, 0);
  });
  await test('unsupported types are rejected with a useful message; HEIC gets iPhone guidance', async () => {
    const h = makeHarness();
    await h.intake.handle([file(Buffer.from('x'), 'a.gif', 'image/gif'), file(Buffer.from('x'), 'IMG_2.HEIC', 'image/heic')], 'file');
    assert.strictEqual(h.calls.added.length, 0);
    assert.match(h.calls.errors[0], /formato non supportato/); assert.match(h.calls.errors[1], /Più compatibile/);
  });
  await test('app.js still carries the original accepted types, drag/drop and clipboard paths', () => {
    for (const needle of ["ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']", "'dragenter'", "'drop'", "addFiles(pastedFiles, 'paste')", "addFiles(e.dataTransfer.files, 'drop')", "takeInputFiles(els.fileInput, 'file')", "takeInputFiles(e.target, 'camera')", "takeInputFiles(e.target, 'gallery')"]) assert.ok(appSource.includes(needle), needle);
  });
  await test('index.html: preview modal, buttons and script order (helpers before app.js)', () => {
    for (const id of ['image-preview-modal', 'image-preview-canvas', 'image-preview-use', 'image-preview-retake', 'image-preview-status']) assert.ok(indexHtml.includes(`id="${id}"`), id);
    assert.ok(indexHtml.includes('>Usa foto<') && indexHtml.includes('>Rifai<'));
    const order = ['/uploadQuality.js', '/imageIntake.js', '/app.js'].map((s) => indexHtml.indexOf(`<script src="${s}">`));
    assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2]);
  });

  // ============ row errors, states, toast ============
  const mathOk = (row) => row.math_verified === true && [row.subtotal, row.vat_amount, row.total].every((n) => typeof n === 'number');
  const goodRow = { source_file: 'a.pdf', supplier: 'Rossi Srl', invoice_number: 'F-1', date: '2026-10-01', subtotal: 100, vat_amount: 22, total: 122, currency: 'EUR', math_verified: true };
  await test('row.error is shown only as a safe friendly message (no provider text, filename, codes, stack)', () => {
    const provider = Quality.rowQuality({ source_file: 'secret-name.pdf', error: 'Estrazione fallita per "secret-name.pdf": errore del servizio IA.', error_code: 'EXTRACTION_FAILED' }, mathOk);
    assert.strictEqual(provider.state, 'UNREADABLE');
    assert.strictEqual(provider.message, 'Il servizio di analisi è temporaneamente non disponibile. Riprova tra poco.');
    const unreadable = Quality.rowQuality({ error: 'PDF non leggibile: impossibile verificare il numero di pagine.', error_code: 'PDF_UNPARSEABLE' }, mathOk);
    assert.strictEqual(unreadable.message, 'Non siamo riusciti a leggere questo documento. Prova con un file diverso o una foto più nitida.');
    const unknown = Quality.rowQuality({ error: 'TypeError: boom at /srv/app.js:1', error_code: 'EXTRACTION_FAILED' }, mathOk);
    assert.strictEqual(unknown.message, 'Non siamo riusciti ad analizzare questo documento.');
    for (const r of [provider, unreadable, unknown]) for (const bad of ['secret-name', 'IA.', 'EXTRACTION_FAILED', 'PDF_UNPARSEABLE', 'TypeError', '/srv']) assert.ok(!r.message.includes(bad), bad);
    assert.match(Quality.rowQuality({ error: 'Il file supera il limite di 20 pagine.', error_code: 'MAX_PAGES_PER_FILE_EXCEEDED' }, mathOk).message, /limite è 20 pagine/);
  });
  await test('app.js renders the safe row message escaped and never prints row.error', () => {
    assert.ok(appSource.includes('escapeHtml(quality.message)')); assert.ok(!/\$\{[^}]*row\.error/.test(appSource));
    assert.ok(appSource.includes('✕ Non leggibile'));
  });
  await test('OK only when every key field is present and the math is valid', () => {
    assert.strictEqual(Quality.rowQuality(goodRow, mathOk).state, 'OK');
  });
  await test('missing supplier / invoice number / date / currency => CHECK naming the fields', () => {
    for (const [field, label] of [['supplier', 'fornitore'], ['invoice_number', 'numero fattura'], ['date', 'data'], ['currency', 'valuta']]) {
      for (const empty of ['', null, undefined, '  ']) {
        const q = Quality.rowQuality({ ...goodRow, [field]: empty }, mathOk);
        assert.strictEqual(q.state, 'CHECK', field); assert.ok(q.message.includes(label), field);
      }
    }
  });
  await test('structured provider JSON with empty fields is NOT marked OK', () => {
    const q = Quality.rowQuality({ source_file: 'x.jpg', supplier: '', invoice_number: '', date: '', subtotal: null, vat_amount: null, total: 0, currency: '', math_verified: false }, mathOk);
    assert.strictEqual(q.state, 'CHECK');
  });
  await test('failed math => CHECK; failed row => UNREADABLE; client photo warning => CHECK', () => {
    assert.strictEqual(Quality.rowQuality({ ...goodRow, math_verified: false }, mathOk).state, 'CHECK');
    assert.strictEqual(Quality.rowQuality({ ...goodRow, total: 'x' }, mathOk).state, 'CHECK');
    assert.strictEqual(Quality.rowQuality({ source_file: 'x', error: 'boom', error_code: 'EXTRACTION_FAILED' }, mathOk).state, 'UNREADABLE');
    const q = Quality.rowQuality({ ...goodRow, _clientNotes: ['Risoluzione bassa: il testo potrebbe non essere leggibile.'] }, mathOk);
    assert.strictEqual(q.state, 'CHECK'); assert.match(q.message, /Risoluzione bassa/);
  });
  await test('toast: all success => "Estrazione completata."', () => {
    const s = Quality.summarizeExtraction([goodRow, goodRow], mathOk);
    assert.deepStrictEqual([s.kind, s.message, s.isError], ['success', 'Estrazione completata.', false]);
  });
  await test('toast: partial success (some failed or to check) never claims plain success', () => {
    const failed = { source_file: 'x', error: 'boom', error_code: 'EXTRACTION_FAILED' };
    for (const rows of [[goodRow, failed], [goodRow, { ...goodRow, supplier: '' }], [failed, { ...goodRow, supplier: '' }]]) {
      const s = Quality.summarizeExtraction(rows, mathOk);
      assert.deepStrictEqual([s.kind, s.message, s.isError], ['partial', 'Estrazione completata con alcuni documenti da verificare.', false]);
    }
  });
  await test('toast: all failed (or no rows) => error, never "Estrazione completata"', () => {
    const failed = { source_file: 'x', error: 'boom', error_code: 'PDF_UNPARSEABLE' };
    for (const rows of [[failed], [failed, failed], []]) {
      const s = Quality.summarizeExtraction(rows, mathOk);
      assert.deepStrictEqual([s.kind, s.message, s.isError], ['failed', 'Non è stato possibile analizzare i documenti.', true]);
      assert.ok(!s.message.includes('completata'));
    }
  });
  await test('app.js skips the paywall survey and uses the error toast when everything failed', () => {
    assert.ok(appSource.includes('showToast(summary.message, summary.isError)')); assert.ok(appSource.includes("summary.kind !== 'failed'"));
    assert.ok(!appSource.includes('Estrazione completata:'));
  });

  // ============ privacy / scope ============
  await test('new modules never log or persist anything and add no network calls', () => {
    for (const f of ['public/uploadQuality.js', 'public/imageIntake.js']) {
      const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.ok(!/console\.|localStorage|sessionStorage|fetch\(|XMLHttpRequest|indexedDB|FileReader/.test(code), f);
    }
  });
  await test('no live camera scanner, edge detection or heavy dependency was added', () => {
    const all = ['public/app.js', 'public/imageIntake.js', 'public/uploadQuality.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    assert.ok(!/getUserMedia|cv\.js|opencv|jscanify/i.test(all));
    const deps = Object.keys(require('../package.json').dependencies);
    assert.ok(!deps.some((d) => /sharp|jimp|canvas|opencv/i.test(d)));
  });

  out(`PASS: ${pass}\nFAIL: ${fail}\nSKIPPED: 0\nTOTAL: ${pass + fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((error) => { out('FATAL: ' + error.stack); process.exit(1); });
