const path = require('path');
const { Worker } = require('worker_threads');
const { getMaxPagesPerFile, getPdfParseTimeoutMs } = require('./config');

// pdf-lib su input malformato può occupare un thread per decine di secondi
// (scansione byte per byte, sincrona). Il parsing avviene quindi in UN solo
// worker condiviso dal processo, mai nel main event loop: i job restano in
// coda, ognuno con un timeout rigido. Allo scadere (o se il worker muore) il
// worker viene terminato e sostituito, il job fallisce chiuso come PDF non
// leggibile e la coda prosegue.
const WORKER_FILE = path.join(__dirname, 'pdfPageCountWorker.js');
const queue = [];
let worker = null; // { thread, ready, detach }
let active = null; // { id, job, timer, startedAt, bytes }
let nextJobId = 0;

function startWorker() {
  const thread = new Worker(WORKER_FILE);
  const state = { thread, ready: false, detach: null };

  const onMessage = (message) => {
    if (message && message.ready) {
      state.ready = true;
      pump();
      return;
    }
    if (!message || worker !== state || !active || active.id !== message.id) return;
    const finished = active;
    active = null;
    clearTimeout(finished.timer);
    thread.unref(); // un worker inattivo non deve tenere vivo il processo
    if (message.failed) finished.job.reject(new Error('PDF parse failed'));
    else finished.job.resolve(message.pages);
    pump();
  };
  const onFailure = () => retire(state, 'PDF_PARSE_WORKER_FAILURE');

  thread.on('message', onMessage);
  thread.on('error', onFailure);
  thread.on('exit', onFailure);
  state.detach = () => {
    thread.off('message', onMessage);
    thread.off('error', onFailure);
    thread.off('exit', onFailure);
    thread.on('error', () => {}); // un errore tardivo non deve diventare un crash
  };
  worker = state;
  return state;
}

// Termina e sostituisce il worker. Il job attivo (o, se il worker non è mai
// partito, il primo in coda) fallisce chiuso; gli altri restano in coda.
function retire(state, code) {
  if (worker !== state) return;
  worker = null;
  state.detach();
  state.thread.terminate().catch(() => {});

  const failed = active;
  active = null;
  let rejected = failed && failed.job;
  if (failed) clearTimeout(failed.timer);
  else if (!state.ready && queue.length) rejected = queue.shift();

  if (rejected) {
    // Solo metadati non sensibili: mai nome file, contenuto o byte del PDF.
    console.error(`[pageCounter] error_code=${code}`, JSON.stringify({
      duration_ms: failed ? Date.now() - failed.startedAt : 0,
      file_bytes: failed ? failed.bytes : null,
    }));
    rejected.reject(Object.assign(new Error('PDF parse failed'), { code }));
  }
  pump();
}

function pump() {
  if (active || queue.length === 0) return;
  const state = worker || startWorker();
  if (!state.ready) return; // l'avvio del worker non consuma il timeout del job

  const job = queue.shift();
  let timeoutMs;
  try {
    timeoutMs = getPdfParseTimeoutMs();
  } catch (error) {
    job.reject(error);
    pump();
    return;
  }

  // Copia esplicita: il Buffer originale resta integro per la chiamata al provider.
  const copy = new Uint8Array(job.buffer.byteLength);
  copy.set(job.buffer);
  const id = ++nextJobId;
  const timer = setTimeout(() => retire(state, 'PDF_PARSE_TIMEOUT'), timeoutMs);
  active = { id, job, timer, startedAt: Date.now(), bytes: copy.byteLength };
  job.buffer = null;
  state.thread.ref();
  state.thread.postMessage({ id, bytes: copy }, [copy.buffer]);
}

// Conta le pagine REALI di un PDF (in memoria, mai su disco). Un PDF
// multipagina deve contare come N "pagine" ai fini del limite di piano,
// non come 1 singolo file: altrimenti il consumo reale di crediti API
// (una chiamata a Claude per pagina/documento) sarebbe molto più alto di
// quanto riflesso nel limite mostrato all'utente.
async function countPdfPages(buffer) {
  const pages = await new Promise((resolve, reject) => {
    queue.push({ buffer, resolve, reject });
    pump();
  });
  if (!Number.isSafeInteger(pages) || pages < 1) throw new Error('Invalid PDF page count');
  return pages;
}

// Conta le "pagine" di un singolo file caricato: per un PDF sono le pagine
// reali del documento; per un'immagine (JPG/PNG/WEBP) conta sempre come 1.
// Un PDF non analizzabile viene rifiutato prima di qualunque chiamata IA.
async function countFilePages(file) {
  if (file.mimetype !== 'application/pdf') {
    return 1;
  }
  try {
    return await countPdfPages(file.buffer);
  } catch {
    throw Object.assign(new Error('PDF non leggibile: impossibile verificare il numero di pagine.'), { code: 'PDF_UNPARSEABLE' });
  }
}

// Conta il totale di pagine per un intero set di file caricati in una
// richiesta (somma delle pagine reali di ciascun file).
async function countTotalPages(files) {
  const maxPages = getMaxPagesPerFile();
  const checks = await Promise.all(files.map(async (file) => {
    try {
      const pages = await countFilePages(file);
      if (pages > maxPages) {
        return { pages: 0, error: Object.assign(new Error(`Il file supera il limite di ${maxPages} pagine.`), { code: 'MAX_PAGES_PER_FILE_EXCEEDED' }) };
      }
      return { pages, error: null };
    } catch (error) {
      if (error.code !== 'PDF_UNPARSEABLE') throw error;
      return { pages: 0, error };
    }
  }));
  const counts = checks.map((check) => check.pages);
  return { counts, errors: checks.map((check) => check.error), total: counts.reduce((sum, n) => sum + n, 0) };
}

module.exports = { countPdfPages, countFilePages, countTotalPages };
