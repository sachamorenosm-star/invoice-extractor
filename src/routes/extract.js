const express = require('express');
const rateLimit = require('express-rate-limit');
const { upload } = require('../middleware/upload');
const { identifyUser, enforceScanLimit } = require('../middleware/auth');
const { extractInvoiceData } = require('../services/claudeService');
const { applyIndependentVerification } = require('../utils/mathVerifier');
const { getPlanStatus, recordScans, releaseTestDailyQuota } = require('../services/stripeService');
const { countTotalPages } = require('../utils/pageCounter');

const router = express.Router();

// TEST_MODE: require authenticated users (magic-link session), reject anonymous X-User-Id
function requireAuthIfTestMode(req, res, next) {
  if (process.env.TEST_MODE === 'true' && !req.isAuthenticated) {
    return res.status(401).json({
      error: 'Accedi per utilizzare la versione di test.',
      code: 'TEST_MODE_AUTH_REQUIRED',
    });
  }
  next();
}

// Rate limiting specifico per /api/extract: max 3 richieste per minuto.
// Per utenti autenticati, usa userId come chiave. Per anonimi, usa IP.
// Questo protegge dalla velocità di abuso (spam requests) e dai costi API.
const extractLimiter = rateLimit({
  windowMs: 60 * 1000,           // 1 minuto
  max: 3,                        // massimo 3 richieste per finestra
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Se l'utente è autenticato (session o X-User-Id valido), usa lo userId
    // come chiave stabile, così il limite è per utente, non per IP.
    // Per utenti anonimo, fallback a IP address.
    if (req.userId) {
      return `user:${req.userId}`;
    }
    // req.ip è fornito da Express e compatibile con IPv4/IPv6
    return `ip:${req.ip}`;
  },
  message: { error: 'Troppe richieste di estrazione. Attendi un minuto prima di caricare altri file.' },
});

// Conta le pagine REALI dei file caricati (un PDF multipagina vale N
// pagine, un'immagine vale sempre 1) PRIMA di chiamare l'API Claude, così
// il limite di piano viene applicato sul consumo effettivo e una richiesta
// che lo supererebbe viene bloccata senza sprecare crediti IA.
async function countRequestPages(req) {
  if (!req.files || req.files.length === 0) return 0;
  const { counts, total } = await countTotalPages(req.files);
  // Pagine per singolo file (stesso ordine di req.files): il route handler
  // le riusa per rilasciare la quota TEST_MODE solo dei file che falliscono
  // l'estrazione, senza doverle ricontare.
  req.pageCountsPerFile = counts;
  return total;
}

router.post(
  '/',
  identifyUser,
  requireAuthIfTestMode,
  extractLimiter,
  upload.array('invoices'),
  enforceScanLimit(countRequestPages),
  async (req, res, next) => {
    const isTestMode = process.env.TEST_MODE === 'true';
    const userId = req.userId || 'anonymous-shared';
    const totalPages = req.scanCount;
    // Diventa true solo quando la quota TEST_MODE riservata è stata
    // interamente "sistemata" (mantenuta per i successi, rilasciata per i
    // fallimenti). Usato dalla rete di sicurezza nel catch per non perdere
    // mai quota riservata in caso di errore imprevisto.
    let testQuotaSettled = false;

    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Nessun file caricato.' });
      }

      const pageCounts = req.pageCountsPerFile || req.files.map(() => 1);

      // Elaborazione in parallelo: ogni file è un Buffer in RAM, inviato a
      // Claude e mai scritto su disco (GDPR zero-retention). Un singolo file
      // può contenere PIÙ fatture/ricevute distinte (es. una scansione
      // cumulativa multipagina): extractInvoiceData restituisce un oggetto
      // { records, truncated, extractedCount } per ciascun file, che qui
      // appiattiamo in un'unica lista di risultati e aggreghiamo per
      // segnalare un'eventuale estrazione incompleta (troncamento IA).
      const resultsPerFile = await Promise.all(
        req.files.map(async (file, index) => {
          try {
            const extraction = await extractInvoiceData(file.buffer, file.mimetype, file.originalname);
            return {
              filename: file.originalname,
              pages: pageCounts[index],
              failed: false,
              records: extraction.records.map((extracted) => applyIndependentVerification(extracted)),
              truncated: extraction.truncated,
              extractedCount: extraction.extractedCount,
            };
          } catch (err) {
            return {
              filename: file.originalname,
              pages: pageCounts[index],
              failed: true,
              records: [{
                source_file: file.originalname,
                supplier: '',
                invoice_number: '',
                date: '',
                subtotal: null,
                vat_amount: null,
                total: null,
                currency: '',
                math_verified: false,
                error: err.message || 'Errore di estrazione.',
              }],
              truncated: false,
              extractedCount: 0,
            };
          }
          // Nota: il buffer del file (`file.buffer`) esce di scope al termine
          // di questa callback e non viene mai persistito: viene raccolto dal
          // garbage collector subito dopo l'invio ad Anthropic.
        }),
      );
      const results = resultsPerFile.flatMap((r) => r.records);
      const truncatedFiles = resultsPerFile.filter((r) => r.truncated);

      if (isTestMode) {
        // La quota TEST_MODE per totalPages è già stata riservata
        // ATOMICAMENTE in enforceScanLimit, PRIMA della chiamata ad
        // Anthropic. Qui rilasciamo solo le pagine dei file che sono
        // effettivamente falliti: le pagine dei file riusciti restano
        // consumate dalla riserva. NON chiamiamo recordScans qui: lo
        // farebbe incrementare di nuovo la stessa quota già riservata
        // (double counting).
        const failedPages = resultsPerFile
          .filter((r) => r.failed)
          .reduce((sum, r) => sum + r.pages, 0);
        if (failedPages > 0) {
          releaseTestDailyQuota(userId, failedPages);
        }
        testQuotaSettled = true;
      } else {
        // Il conteggio pagine (e quindi il consumo di quota) resta invariato:
        // si basa sulle pagine REALI del PDF (totalPages), non sul numero di
        // fatture riconosciute al suo interno.
        recordScans(userId, totalPages);
      }

      const responseBody = {
        results,
        plan: getPlanStatus(userId),
        pagesProcessed: totalPages,
      };

      // Segnaliamo esplicitamente un'estrazione incompleta (mai in
      // silenzio): il frontend mostra un banner persistente, non un toast.
      if (truncatedFiles.length > 0) {
        responseBody.incomplete = true;
        responseBody.incompleteMessage = truncatedFiles.length === 1
          ? `Estrazione incompleta: elaborati ${truncatedFiles[0].extractedCount} documenti dal file "${truncatedFiles[0].filename}", che potrebbe contenerne di più. Prova a caricare il file in gruppi più piccoli.`
          : `Estrazione incompleta per ${truncatedFiles.length} file: alcuni documenti potrebbero non essere stati estratti. Prova a caricare i file in gruppi più piccoli.`;
        responseBody.truncatedFiles = truncatedFiles.map((r) => ({
          filename: r.filename,
          extractedCount: r.extractedCount,
        }));
      }

      res.json(responseBody);
    } catch (err) {
      // Rete di sicurezza: se un errore imprevisto interrompe la richiesta
      // DOPO la riserva atomica TEST_MODE ma prima che le pagine siano state
      // "sistemate" (mantenute o rilasciate), rilasciamo l'intera quota
      // riservata per non perderla permanentemente. decrementTestUsage ha
      // già un floor a zero, quindi un rilascio ridondante non può mai
      // portare il contatore sotto zero.
      if (isTestMode && !testQuotaSettled) {
        releaseTestDailyQuota(userId, totalPages);
      }
      next(err);
    }
  },
);

module.exports = router;
