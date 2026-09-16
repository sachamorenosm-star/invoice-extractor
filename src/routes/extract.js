const express = require('express');
const { upload } = require('../middleware/upload');
const { identifyUser, enforceScanLimit } = require('../middleware/auth');
const { extractInvoiceData } = require('../services/claudeService');
const { applyIndependentVerification } = require('../utils/mathVerifier');
const { getPlanStatus, recordScans } = require('../services/stripeService');
const { countTotalPages } = require('../utils/pageCounter');

const router = express.Router();

// Conta le pagine REALI dei file caricati (un PDF multipagina vale N
// pagine, un'immagine vale sempre 1) PRIMA di chiamare l'API Claude, così
// il limite di piano viene applicato sul consumo effettivo e una richiesta
// che lo supererebbe viene bloccata senza sprecare crediti IA.
async function countRequestPages(req) {
  if (!req.files || req.files.length === 0) return 0;
  const { total } = await countTotalPages(req.files);
  return total;
}

router.post(
  '/',
  identifyUser,
  upload.array('invoices'),
  enforceScanLimit(countRequestPages),
  async (req, res, next) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Nessun file caricato.' });
      }

      const userId = req.userId || 'anonymous-shared';
      const totalPages = req.scanCount;

      // Elaborazione in parallelo: ogni file è un Buffer in RAM, inviato a
      // Claude e mai scritto su disco (GDPR zero-retention).
      const results = await Promise.all(
        req.files.map(async (file) => {
          try {
            const extracted = await extractInvoiceData(file.buffer, file.mimetype, file.originalname);
            return applyIndependentVerification(extracted);
          } catch (err) {
            return {
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
            };
          }
          // Nota: il buffer del file (`file.buffer`) esce di scope al termine
          // di questa callback e non viene mai persistito: viene raccolto dal
          // garbage collector subito dopo l'invio ad Anthropic.
        }),
      );

      recordScans(userId, totalPages);

      res.json({
        results,
        plan: getPlanStatus(userId),
        pagesProcessed: totalPages,
      });
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
