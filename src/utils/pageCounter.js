const { PDFDocument } = require('pdf-lib');

// Conta le pagine REALI di un PDF (in memoria, mai su disco). Un PDF
// multipagina deve contare come N "pagine" ai fini del limite di piano,
// non come 1 singolo file: altrimenti il consumo reale di crediti API
// (una chiamata a Claude per pagina/documento) sarebbe molto più alto di
// quanto riflesso nel limite mostrato all'utente.
async function countPdfPages(buffer) {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  return doc.getPageCount();
}

// Conta le "pagine" di un singolo file caricato: per un PDF sono le pagine
// reali del documento; per un'immagine (JPG/PNG/WEBP) conta sempre come 1.
// Se il PDF non è analizzabile (corrotto, protetto in modo non gestibile),
// non blocchiamo la richiesta: applichiamo un fallback conservativo di 1
// pagina e logghiamo l'accaduto (senza esporre contenuto del file).
async function countFilePages(file) {
  if (file.mimetype !== 'application/pdf') {
    return 1;
  }
  try {
    return await countPdfPages(file.buffer);
  } catch (err) {
    console.error(`[pageCounter] Impossibile contare le pagine di "${file.originalname}", conteggiato come 1 pagina:`, err.message);
    return 1;
  }
}

// Conta il totale di pagine per un intero set di file caricati in una
// richiesta (somma delle pagine reali di ciascun file).
async function countTotalPages(files) {
  const counts = await Promise.all(files.map(countFilePages));
  return { counts, total: counts.reduce((sum, n) => sum + n, 0) };
}

module.exports = { countPdfPages, countFilePages, countTotalPages };
