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

// Le richieste ordinarie ricevono lo stesso messaggio generico senza
// rivelare account o inviti. Un errore noto di consegna dà un errore temporaneo.
const LOGIN_RESPONSE = "Se l'indirizzo è autorizzato, riceverai un link di accesso.";
const LOGIN_UNAVAILABLE = 'Accesso temporaneamente non disponibile. Riprova tra poco.';

router.post('/request-magic-link', magicLinkLimiter, async (req, res) => {
  try {
    const email = req.body?.email;
    const anonUserId = req.get('X-User-Id') || null;

    const delivery = await authService.sendMagicLink(email, anonUserId);
    if (delivery.unavailable) return res.status(503).json({ error: LOGIN_UNAVAILABLE });
    res.json({ message: LOGIN_RESPONSE });
  } catch {
    console.error('[auth] login_request_failed', JSON.stringify({ request_id: req.requestId }));
    res.status(503).json({ error: LOGIN_UNAVAILABLE });
  }
});

// Verification links are bearer credentials: never cache or send referrers.
router.use('/verify', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Express routes HEAD through this GET as well. Both are read-only.
router.get('/verify', (req, res) => {
  try {
    const { token } = req.query;
    if (!authService.inspectLoginToken(token)) return res.redirect('/?login=expired');
    // token is validated as exactly 64 hex characters, safe in an attribute.
    res.type('html').send(`<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conferma accesso a InvoiceExtract</title></head>
<body><main><h1>Conferma accesso a InvoiceExtract</h1>
<p>Premi Accedi per completare l'accesso. Il link è valido per 15 minuti.</p>
<form method="post" action="/api/auth/verify">
<input type="hidden" name="token" value="${token}">
<button type="submit">Accedi</button></form></main></body></html>`);
  } catch {
    console.error('[auth] login_verification_failed', JSON.stringify({ request_id: req.requestId }));
    res.status(503).send(LOGIN_UNAVAILABLE);
  }
});

// Only the explicit form POST may consume a token and set the session.
router.post('/verify', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  try {
    const origin = req.get('Origin');
    const frontendOrigin = new URL(process.env.FRONTEND_URL || 'http://localhost:3000').origin;
    if ((origin && origin !== frontendOrigin) || req.get('Sec-Fetch-Site') === 'cross-site' ||
        /prefetch|prerender/i.test(`${req.get('Purpose') || ''} ${req.get('Sec-Purpose') || ''}`)) {
      return res.status(403).send('Richiesta di accesso non valida.');
    }
    const result = authService.verifyLoginToken(req.body?.token);
    if (!result) return res.redirect(303, '/?login=expired');
    const userId = authService.findOrCreateUserForEmail(result.email, result.anonUserId);
    authService.setSessionCookie(res, userId, result.email);
    res.redirect(303, '/?login=success');
  } catch {
    console.error('[auth] login_confirmation_failed', JSON.stringify({ request_id: req.requestId }));
    res.status(503).send(LOGIN_UNAVAILABLE);
  }
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
