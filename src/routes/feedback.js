const express = require('express');
const rateLimit = require('express-rate-limit');
const database = require('../services/database');
const authService = require('../services/authService');

const router = express.Router();

const VALID_USEFULNESS = ['molto', 'abbastanza', 'poco'];
const VALID_WOULD_PAY = ['si', 'forse', 'no'];

// Limite anti-abuso: max 10 invii ogni 10 minuti per IP. Il micro-sondaggio
// è mostrato al massimo una volta per sessione browser (vedi app.js), ma
// proteggiamo comunque l'endpoint da submission automatizzate.
const feedbackLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Troppe richieste. Riprova tra qualche minuto.' },
});

// Salva un segnale di feedback anonimo (nessun collegamento ai dati delle
// fatture elaborate). L'email è del tutto opzionale: viene salvata solo se
// l'utente la lascia volontariamente per essere ricontattato.
router.post('/', feedbackLimiter, (req, res, next) => {
  try {
    const { usefulness_rating: usefulnessRating, would_pay: wouldPay, optional_email: optionalEmail } = req.body || {};

    if (!VALID_USEFULNESS.includes(usefulnessRating)) {
      return res.status(400).json({ error: 'Valore di gradimento non valido.' });
    }
    if (!VALID_WOULD_PAY.includes(wouldPay)) {
      return res.status(400).json({ error: 'Valore "pagheresti" non valido.' });
    }
    if (optionalEmail && !authService.isValidEmail(optionalEmail)) {
      return res.status(400).json({ error: 'Email non valida.' });
    }

    database.insertFeedbackSignal({
      usefulness_rating: usefulnessRating,
      would_pay: wouldPay,
      optional_email: optionalEmail ? optionalEmail.trim().toLowerCase() : null,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
