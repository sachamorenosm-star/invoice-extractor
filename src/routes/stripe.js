const express = require('express');
const { identifyUser } = require('../middleware/auth');
const database = require('../services/database');
const {
  createCheckoutSession,
  createPortalSession,
  constructWebhookEvent,
  handleWebhookEvent,
  getPlanStatus,
  VALID_TIERS,
} = require('../services/stripeService');

const router = express.Router();

// Crea una sessione di Stripe Checkout per il piano scelto dall'utente
// (Starter, Business, Growth o Studio — "plan" nel body della richiesta).
router.post('/create-checkout-session', identifyUser, async (req, res, next) => {
  try {
    // In modalità "waitlist" (pre-lancio, senza Partita IVA attiva) il
    // checkout reale resta disattivato: il codice sotto non viene toccato,
    // così riattivarlo in futuro basta impostare LAUNCH_MODE=live.
    if (process.env.LAUNCH_MODE !== 'live') {
      return res.status(403).json({ error: 'I pagamenti non sono ancora attivi. Iscriviti alla lista d\'attesa dalla sezione Prezzi.' });
    }

    if (!req.userId) {
      return res.status(400).json({ error: 'Header X-User-Id mancante o non valido.' });
    }

    const plan = req.body?.plan;
    if (!VALID_TIERS.includes(plan) || plan === 'free') {
      return res.status(400).json({ error: 'Piano non valido o mancante nella richiesta.' });
    }

    const session = await createCheckoutSession(req.userId, plan);
    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

// Stato del piano/utilizzo per l'utente corrente
router.get('/status', identifyUser, (req, res) => {
  const userId = req.userId || 'anonymous-shared';
  res.json({ plan: getPlanStatus(userId) });
});

// Crea una sessione del Customer Portal Stripe, per permettere all'utente
// di gestire autonomamente l'abbonamento esistente (cambio piano, metodo
// di pagamento, fatture, disdetta). Richiede che l'utente (identificato
// da sessione o da X-User-Id) abbia già un stripe_customer_id salvato,
// cioè un abbonamento almeno una volta avviato tramite Checkout.
router.post('/create-portal-session', identifyUser, async (req, res, next) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Devi accedere per gestire il tuo abbonamento.' });
    }

    const user = database.getUser(req.userId);
    if (!user || !user.stripe_customer_id) {
      return res.status(400).json({ error: 'Nessun abbonamento attivo da gestire. Scegli un piano nella sezione Prezzi.' });
    }

    const returnUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/?section=account`;
    const session = await createPortalSession(user.stripe_customer_id, returnUrl);
    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

// Webhook Stripe: riceve gli eventi di attivazione/disattivazione
// dell'abbonamento. Il body DEVE arrivare raw (configurato in server.js)
// per poter verificare la firma.
router.post('/webhook', async (req, res) => {
  const signature = req.get('stripe-signature');

  let event;
  try {
    event = constructWebhookEvent(req.body, signature);
  } catch (err) {
    console.error('[stripe webhook] Firma non valida:', err.message);
    return res.status(400).json({ error: 'Firma del webhook non valida.' });
  }

  try {
    await handleWebhookEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe webhook] Errore gestione evento:', err.message);
    res.status(500).json({ error: 'Errore durante la gestione del webhook.' });
  }
});

module.exports = router;
