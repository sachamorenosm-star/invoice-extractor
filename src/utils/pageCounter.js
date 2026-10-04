const { PDFDocument } = require('pdf-lib');
const { getMaxPagesPerFile } = require('./config');

// Conta le pagine REALI di un PDF (in memoria, mai su disco). Un PDF
// multipagina deve contare come N "pagine" ai fini del limite di piano,
// non come 1 singolo file: altrimenti il consumo reale di crediti API
// (una chiamata a Claude per pagina/documento) sarebbe molto più alto di
// quanto riflesso nel limite mostrato all'utente.
async function countPdfPages(buffer) {
  const doc = await PDFDocument.load(buffer);
  const pages = doc.getPageCount();
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
