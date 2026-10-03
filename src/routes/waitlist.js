const express = require('express');
const rateLimit = require('express-rate-limit');
const database = require('../services/database');
const authService = require('../services/authService');
const { VALID_TIERS } = require('../services/stripeService');

const router = express.Router();

// Limite anti-abuso: max 5 richieste ogni 10 minuti per IP. Usiamo l'IP
// (non l'email) come chiave, perché a differenza del Magic Link qui non
// c'è nulla da proteggere lato enumerazione account: l'obiettivo è solo
// evitare submission automatizzate di massa.
const waitlistLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Troppe richieste. Riprova tra qualche minuto.' },
});

// Registra l'interesse per un piano durante la modalità "waitlist"
// (LAUNCH_MODE=waitlist): nessun pagamento viene mai processato qui.
router.post('/join', waitlistLimiter, (req, res, next) => {
  try {
    const { email, plan } = req.body || {};

    if (!authService.isValidEmail(email)) {
      return res.status(400).json({ error: 'Indirizzo email non valido.' });
    }
    if (!VALID_TIERS.includes(plan) || plan === 'free') {
      return res.status(400).json({ error: 'Piano non valido.' });
    }

    database.insertWaitlistSignup({ email: email.trim().toLowerCase(), plan });
    res.json({ message: 'Grazie! Ti scriveremo appena gli abbonamenti saranno attivi.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
