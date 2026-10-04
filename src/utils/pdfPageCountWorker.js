// Runs in a worker thread: pdf-lib parsing can monopolise a thread for seconds on
// malformed input, so it must never run on the main event loop. This file does
// nothing but page counting; quota, provider and HTTP logic stay in the parent.
const { parentPort } = require('worker_threads');

// pdf-lib prints parser warnings (object offsets only); they are noise here.
console.warn = () => {};

const { PDFDocument } = require('pdf-lib');

parentPort.on('message', async ({ id, bytes }) => {
  try {
    const doc = await PDFDocument.load(bytes);
    parentPort.postMessage({ id, pages: doc.getPageCount() });
  } catch {
    parentPort.postMessage({ id, failed: true });
  }
});

parentPort.postMessage({ ready: true });
