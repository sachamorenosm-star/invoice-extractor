const express = require('express');
const rateLimit = require('express-rate-limit');
const authService = require('../services/authService');
const database = require('../services/database');
const { getPlanStatus } = require('../services/stripeService');

const router = express.Router();

// Limite più stringente specifico per la richiesta di Magic Link (contro
// spam/abuso): max 3 richieste ogni 15 minuti per la stessa email. Se
// l'email manca o non è valida usiamo l'IP come chiave, così non si può
// bypassare il limite variando indirizzo email a caso.
const magicLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = req.body?.email;
    return typeof email === 'string' && email.trim()
      ? `email:${email.trim().toLowerCase()}`
      : `ip:${req.ip}`;
  },
  message: { error: 'Troppe richieste di accesso. Riprova tra qualche minuto.' },
});

// Richiede l'invio di un Magic Link via email. Risponde SEMPRE con lo
// stesso messaggio generico, indipendentemente dal fatto che l'email
// esista già o meno nel sistema, per non permettere enumerazione account.
router.post('/request-magic-link', magicLinkLimiter, async (req, res, next) => {
  try {
    const email = req.body?.email;
    const anonUserId = req.get('X-User-Id') || null;

    if (authService.isValidEmail(email)) {
      await authService.sendMagicLink(email, anonUserId);
    }

    res.json({ message: "Se l'indirizzo è valido, riceverai a breve un'email con il link di accesso." });
  } catch (err) {
    next(err);
  }
});

// Verifica il token dal link ricevuto via email. Se valido, crea/collega
// l'account e imposta il cookie di sessione, poi reindirizza al frontend.
router.get('/verify', (req, res) => {
  const { token } = req.query;
  const result = typeof token === 'string' ? authService.verifyLoginToken(token) : null;

  if (!result) {
    return res.redirect('/?login=expired');
  }

  const userId = authService.findOrCreateUserForEmail(result.email, result.anonUserId);
  authService.setSessionCookie(res, userId, result.email);
  res.redirect('/?login=success');
});

router.post('/logout', (req, res) => {
  authService.clearSessionCookie(res);
  res.json({ ok: true });
});

// Dati dell'utente loggato (per popolare navbar e sezione profilo).
router.get('/me', (req, res) => {
  const session = authService.getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Non autenticato.' });
  }

  const user = database.getUser(session.userId);
  if (!user) {
    return res.status(401).json({ error: 'Non autenticato.' });
  }

  res.json({
    email: user.email,
    recovery_email: user.recovery_email,
    plan: getPlanStatus(session.userId),
  });
});

// Imposta/aggiorna l'email di recupero secondaria dell'utente loggato.
router.post('/recovery-email', (req, res, next) => {
  try {
    const session = authService.getSessionFromRequest(req);
    if (!session) {
      return res.status(401).json({ error: 'Non autenticato.' });
    }

    const recoveryEmail = req.body?.recovery_email;
    if (recoveryEmail && !authService.isValidEmail(recoveryEmail)) {
      return res.status(400).json({ error: 'Email di recupero non valida.' });
    }

    authService.setRecoveryEmail(session.userId, recoveryEmail || null);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
