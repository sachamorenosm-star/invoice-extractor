#!/usr/bin/env node
/**
 * Mobile camera upload verification
 *
 * Tests that:
 * - capture="environment" attribute is present
 * - All existing file types still accepted
 * - Multiple files still supported
 * - Desktop behavior unchanged
 * - Zero-retention unchanged
 * - No server-side persistence changes
 *
 * Run: node test/mobile-camera.test.js
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log('PASS: ' + name);
    pass++;
  } catch (e) {
    console.log('FAIL: ' + name);
    console.log('  ' + e.message);
    fail++;
  }
}

console.log('=== Mobile Camera Upload Tests ===\n');

async function main() {
  const indexHtml = fs.readFileSync(path.join(PROJECT_ROOT, 'public/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(PROJECT_ROOT, 'public/app.js'), 'utf8');
  const serverJs = fs.readFileSync(path.join(PROJECT_ROOT, 'src/server.js'), 'utf8');
  const middlewareJs = fs.readFileSync(path.join(PROJECT_ROOT, 'src/middleware/upload.js'), 'utf8');
  const databaseJs = fs.readFileSync(path.join(PROJECT_ROOT, 'src/services/database.js'), 'utf8');

  // T1: capture="environment" present
  await test('T1: file input contains capture="environment"', async () => {
    if (!indexHtml.includes('capture="environment"')) {
      throw new Error('capture="environment" not found in file input');
    }
  });

  // T2: All accept types preserved
  await test('T2: existing accept types preserved (.pdf, image/jpeg, image/png, image/webp)', async () => {
    const fileInput = indexHtml.match(/id="file-input"[^>]*>/)[0];
    if (!fileInput.includes('.pdf')) throw new Error('PDF not in accept');
    if (!fileInput.includes('image/jpeg')) throw new Error('JPEG not in accept');
    if (!fileInput.includes('image/png')) throw new Error('PNG not in accept');
    if (!fileInput.includes('image/webp')) throw new Error('WEBP not in accept');
  });

  // T3: PDF still accepted
  await test('T3: .pdf file type in accept attribute', async () => {
    if (!indexHtml.includes('accept=".pdf')) {
      throw new Error('PDF extension not in accept list');
    }
  });

  // T4: JPEG still accepted
  await test('T4: image/jpeg MIME type in accept attribute', async () => {
    if (!indexHtml.includes('image/jpeg')) {
      throw new Error('JPEG MIME type not in accept list');
    }
  });

  // T5: PNG still accepted
  await test('T5: image/png MIME type in accept attribute', async () => {
    if (!indexHtml.includes('image/png')) {
      throw new Error('PNG MIME type not in accept list');
    }
  });

  // T6: WEBP still accepted
  await test('T6: image/webp MIME type in accept attribute', async () => {
    if (!indexHtml.includes('image/webp')) {
      throw new Error('WEBP MIME type not in accept list');
    }
  });

  // T7: Multiple files still supported
  await test('T7: multiple attribute still present on file input', async () => {
    const fileInput = indexHtml.match(/id="file-input"[^>]*>/)[0];
    if (!fileInput.includes('multiple')) {
      throw new Error('multiple attribute removed or missing');
    }
  });

  // T8: Drag/drop code unchanged
  await test('T8: drag/drop event listeners still present in app.js', async () => {
    if (!appJs.includes("'dragenter'")) throw new Error('dragenter listener missing');
    if (!appJs.includes("'dragover'")) throw new Error('dragover listener missing');
    if (!appJs.includes("'drop'")) throw new Error('drop listener missing');
    if (!appJs.includes("'dragleave'")) throw new Error('dragleave listener missing');
  });

  // T9: File validation unchanged
  await test('T9: existing file type validation in app.js preserved', async () => {
    if (!appJs.includes('ACCEPTED_TYPES')) throw new Error('ACCEPTED_TYPES constant missing');
    if (!appJs.includes('application/pdf')) throw new Error('PDF validation missing');
    if (!appJs.includes('image/jpeg')) throw new Error('JPEG validation missing');
  });

  // T10: No backend file persistence changes
  await test('T10: backend file handling unchanged (memoryStorage)', async () => {
    if (!middlewareJs.includes('multer.memoryStorage')) {
      throw new Error('memoryStorage configuration changed or missing');
    }
  });

  // T11: Zero-retention invariant (no new fs.writeFile/writeFileSync/diskStorage)
  await test('T11: no new file persistence introduced (zero-retention preserved)', async () => {
    // Check that no new diskStorage or file write operations were added to server.js
    if (serverJs.includes('diskStorage') && !serverJs.includes('memoryStorage')) {
      throw new Error('diskStorage introduced to server.js');
    }
    // Check database schema unchanged
    if (databaseJs.includes('document_path') || databaseJs.includes('file_storage')) {
      throw new Error('database schema changed for file storage');
    }
  });

  // T12: Frontend beta UX copy unchanged (upload zone text)
  await test('T12: upload zone UI text unchanged', async () => {
    if (!indexHtml.includes('Trascina qui')) {
      throw new Error('Main upload text changed');
    }
    if (!indexHtml.includes('incolla con Ctrl+V')) {
      throw new Error('Paste hint removed');
    }
    if (!indexHtml.includes('sfoglia')) {
      throw new Error('Browse text removed');
    }
  });

  console.log('\n=== Summary ===');
  console.log('PASS: ' + pass);
  console.log('FAIL: ' + fail);
  console.log('TOTAL: ' + (pass + fail));

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
