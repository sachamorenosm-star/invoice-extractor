const Stripe = require('stripe');
const database = require('./database');

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// -----------------------------------------------------------------------
// Definizione dei 5 piani. I limiti sono espressi in PAGINE al mese (non in
// numero di file caricati): un PDF multipagina consuma tante "pagine"
// quante ne contiene realmente (vedi src/utils/pageCounter.js).
// -----------------------------------------------------------------------
const VALID_TIERS = ['free', 'starter', 'business', 'growth', 'studio'];

const PLAN_LIMITS = {
  free: parseInt(process.env.FREE_PLAN_MONTHLY_SCANS, 10) || 5,
  starter: parseInt(process.env.STARTER_PLAN_MONTHLY_SCANS, 10) || 30,
  business: parseInt(process.env.BUSINESS_PLAN_MONTHLY_SCANS, 10) || 150,
  growth: parseInt(process.env.GROWTH_PLAN_MONTHLY_SCANS, 10) || 500,
  // "Studio" è tecnicamente una soglia di fair-use interna: all'utente
  // viene sempre mostrata l'etichetta "Illimitato" (vedi getPlanStatus),
  // mai il numero.
  studio: parseInt(process.env.STUDIO_PLAN_MONTHLY_SCANS, 10) || 2000,
};

// Mappa tier -> Stripe Price ID, usata sia per creare la Checkout Session
// sia (in senso inverso) per determinare il tier acquistato a partire dal
// price_id restituito da Stripe nel webhook.
const PLAN_PRICE_IDS = {
  starter: process.env.STARTER_PRICE_ID || null,
  business: process.env.BUSINESS_PRICE_ID || null,
  growth: process.env.GROWTH_PRICE_ID || null,
  studio: process.env.STUDIO_PRICE_ID || null,
};

function mapPriceIdToTier(priceId) {
  if (!priceId) return null;
  const entry = Object.entries(PLAN_PRICE_IDS).find(([, id]) => id && id === priceId);
  return entry ? entry[0] : null;
}

// -----------------------------------------------------------------------
// Store degli utenti/piani, persistito su SQLite (src/services/database.js).
//
// Scelta adatta a un MVP self-hosted: un singolo file su disco (data/),
// senza bisogno di un servizio esterno separato, che sopravvive ai riavvii
// del server. Nessun dato di fatturazione o documento viene mai salvato
// qui: solo id utente anonimo, piano e contatore di utilizzo mensile.
//
// Le funzioni seguenti convertono tra lo shape "riga SQLite" (snake_case,
// come da schema della tabella) e lo shape "oggetto utente" (camelCase)
// usato dal resto di questo modulo.
// -----------------------------------------------------------------------

function currentPeriodKey() {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth()}`;
}

function rowToUser(row) {
  return {
    tier: row.tier,
    scansUsed: row.scans_used,
    periodKey: row.period_key,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
  };
}

function persistUser(userId, user) {
  database.saveUser({
    user_id: userId,
    tier: user.tier,
    scans_used: user.scansUsed,
    period_key: user.periodKey,
    stripe_customer_id: user.stripeCustomerId,
    stripe_subscription_id: user.stripeSubscriptionId,
  });
}

function getOrCreateUser(userId) {
  const periodKey = currentPeriodKey();
  const row = database.getUser(userId);

  let user;
  if (!row) {
    user = { tier: 'free', scansUsed: 0, periodKey, stripeCustomerId: null, stripeSubscriptionId: null };
    database.insertUser({
      user_id: userId,
      tier: user.tier,
      scans_used: user.scansUsed,
      period_key: user.periodKey,
      stripe_customer_id: user.stripeCustomerId,
      stripe_subscription_id: user.stripeSubscriptionId,
    });
    return user;
  }

  user = rowToUser(row);

  // Reset automatico del contatore a ogni nuovo mese
  if (user.periodKey !== periodKey) {
    user.periodKey = periodKey;
    user.scansUsed = 0;
    persistUser(userId, user);
  }

  return user;
}

function getPlanStatus(userId) {
  const user = getOrCreateUser(userId);
  const tier = VALID_TIERS.includes(user.tier) ? user.tier : 'free';
  const limit = PLAN_LIMITS[tier];

  return {
    tier,
    used: user.scansUsed,
    limit,
    // "Studio" è comunicato all'utente come piano illimitato: l'etichetta
    // da mostrare in UI non deve mai rivelare la soglia tecnica (2000).
    limitLabel: tier === 'studio' ? 'Illimitato' : String(limit),
  };
}

function canScan(userId, count = 1) {
  const { used, limit } = getPlanStatus(userId);
  return used + count <= limit;
}

function recordScans(userId, count = 1) {
  const user = getOrCreateUser(userId);
  user.scansUsed += count;
  persistUser(userId, user);
}

function activateSubscription(userId, stripeCustomerId, stripeSubscriptionId, tier) {
  const user = getOrCreateUser(userId);
  if (VALID_TIERS.includes(tier) && tier !== 'free') {
    user.tier = tier;
  }
  user.stripeCustomerId = stripeCustomerId;
  user.stripeSubscriptionId = stripeSubscriptionId;
  persistUser(userId, user);
}

function deactivateSubscriptionByCustomerId(stripeCustomerId) {
  const row = database.getUserByCustomerId(stripeCustomerId);
  if (!row) return;
  const user = rowToUser(row);
  user.tier = 'free';
  user.stripeSubscriptionId = null;
  persistUser(row.user_id, user);
}

// -----------------------------------------------------------------------
// Stripe Checkout
// -----------------------------------------------------------------------
async function createCheckoutSession(userId, planKey) {
  if (!stripe) {
    throw Object.assign(new Error('Stripe non configurato sul server.'), { status: 500 });
  }

  if (!VALID_TIERS.includes(planKey) || planKey === 'free') {
    throw Object.assign(new Error('Piano non valido.'), { status: 400 });
  }

  const priceId = PLAN_PRICE_IDS[planKey];
  if (!priceId) {
    throw Object.assign(
      new Error(`Price ID di Stripe non configurato per il piano "${planKey}".`),
      { status: 500 },
    );
  }

  const user = getOrCreateUser(userId);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: userId,
    customer: user.stripeCustomerId || undefined,
    success_url: process.env.STRIPE_SUCCESS_URL || 'http://localhost:3000/?checkout=success',
    cancel_url: process.env.STRIPE_CANCEL_URL || 'http://localhost:3000/?checkout=cancel',
    // metadata.plan è un fallback usato dal webhook solo se, per qualche
    // motivo, non è possibile risalire al tier dal price_id effettivo
    // della subscription (vedi handleWebhookEvent).
    metadata: { userId, plan: planKey },
  });

  return session;
}

// -----------------------------------------------------------------------
// Stripe Customer Portal — permette all'utente di gestire autonomamente
// l'abbonamento esistente (cambio piano, metodo di pagamento, fatture,
// disdetta) senza dover reimplementare quella UI.
// -----------------------------------------------------------------------
async function createPortalSession(stripeCustomerId, returnUrl) {
  if (!stripe) {
    throw Object.assign(new Error('Stripe non configurato sul server.'), { status: 500 });
  }
  if (!stripeCustomerId) {
    throw Object.assign(
      new Error('Nessun abbonamento attivo da gestire per questo account.'),
      { status: 400 },
    );
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl || process.env.FRONTEND_URL || 'http://localhost:3000',
  });

  return session;
}

function constructWebhookEvent(rawBody, signature) {
  if (!stripe) {
    throw Object.assign(new Error('Stripe non configurato sul server.'), { status: 500 });
  }
  return stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

// Determina il tier acquistato risalendo al price_id REALE della
// subscription Stripe (non ci fidiamo ciecamente del metadata impostato al
// momento del checkout, che potrebbe non riflettere un piano cambiato nel
// frattempo tramite il portale clienti Stripe).
async function resolveTierFromSubscription(subscriptionId, fallbackPlan) {
  if (stripe && subscriptionId) {
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['items.data.price'],
      });
      const priceId = subscription.items?.data?.[0]?.price?.id;
      const tier = mapPriceIdToTier(priceId);
      if (tier) return tier;
    } catch (err) {
      console.error('[stripeService] Impossibile recuperare il price_id della subscription:', err.message);
    }
  }
  // Fallback difensivo: usa il piano dichiarato in metadata al checkout,
  // solo se valido, altrimenti nessun tier determinabile.
  return VALID_TIERS.includes(fallbackPlan) && fallbackPlan !== 'free' ? fallbackPlan : null;
}

async function handleWebhookEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.client_reference_id || session.metadata?.userId;
      if (!userId) break;

      const tier = await resolveTierFromSubscription(session.subscription, session.metadata?.plan);
      if (!tier) {
        console.error(`[stripeService] Impossibile determinare il piano acquistato per l'utente ${userId}: abbonamento non attivato.`);
        break;
      }
      activateSubscription(userId, session.customer, session.subscription, tier);
      console.log(`[stripeService] Abbonamento attivato: utente ${userId} -> piano "${tier}" (subscription ${session.subscription}).`);
      break;
    }
    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const row = database.getUserByCustomerId(subscription.customer);
      if (!row) break;

      if (subscription.status === 'active' || subscription.status === 'trialing') {
        // L'utente potrebbe aver cambiato piano dal portale clienti Stripe:
        // risincronizziamo il tier con il price_id attuale della subscription.
        const priceId = subscription.items?.data?.[0]?.price?.id;
        const tier = mapPriceIdToTier(priceId);
        if (tier) {
          activateSubscription(row.user_id, subscription.customer, subscription.id, tier);
        }
      } else {
        deactivateSubscriptionByCustomerId(subscription.customer);
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      deactivateSubscriptionByCustomerId(subscription.customer);
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      deactivateSubscriptionByCustomerId(invoice.customer);
      break;
    }
    default:
      break;
  }
}

module.exports = {
  VALID_TIERS,
  PLAN_LIMITS,
  getPlanStatus,
  canScan,
  recordScans,
  activateSubscription,
  createCheckoutSession,
  createPortalSession,
  constructWebhookEvent,
  handleWebhookEvent,
};
