require('dotenv').config();
const { parseTestMode, getMaxPagesPerFile, getTestGlobalDailyLimit, startupSummary } = require('./utils/config');
// Validate before loading auth, database or provider modules.
parseTestMode(process.env.TEST_MODE);
getMaxPagesPerFile();
getTestGlobalDailyLimit();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const extractRoutes = require('./routes/extract');
const exportRoutes = require('./routes/export');
const stripeRoutes = require('./routes/stripe');
const authRoutes = require('./routes/auth');
const waitlistRoutes = require('./routes/waitlist');
const feedbackRoutes = require('./routes/feedback');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { getTestDailyLimit } = require('./services/stripeService');

const app = express();
const { requestId, extractionLifecycle } = require('./middleware/requestId');
app.use(requestId);
app.use('/api/extract', extractionLifecycle);

// Proxy fidati: su Render il servizio è raggiungibile SOLO tramite il suo
// load balancer (un solo hop), che termina TLS e inoltra a Express. Senza
// questa impostazione req.ip è l'indirizzo del proxy: tutti i visitatori
// condividerebbero lo stesso bucket dei rate limiter. Con "1" Express usa
// l'ultimo valore di X-Forwarded-For (quello aggiunto dall'hop fidato) e
// ignora le voci precedenti, che il client può falsificare. Mai "true"
// (si fiderebbe della voce più a sinistra, controllata dall'attaccante).
// TRUST_PROXY_HOPS=0 disattiva (es. server esposto direttamente).
// Va impostato PRIMA di ogni middleware che legge req.ip / req.protocol.
function parseTrustProxyHops(raw) {
  if (raw === undefined || String(raw).trim() === '') return 1;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n <= 5) return n;
  console.warn('[server] TRUST_PROXY_HOPS non valido (atteso intero 0-5): uso il default 1.');
  return 1;
}
app.set('trust proxy', parseTrustProxyHops(process.env.TRUST_PROXY_HOPS));

const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || `http://localhost:${PORT}`;

// ---------------------------------------------------------------------
// Sicurezza baseline
// ---------------------------------------------------------------------
// Helmet aggiunge "upgrade-insecure-requests" di default (anche se non
// elencata qui sotto: viene unita dai default di Helmet). Questa direttiva
// istruisce il browser a riscrivere in HTTPS qualunque sottorisorsa relativa
// (es. /dist/styles.css, /assets/logo.svg) PRIMA di richiederla — anche
// quando la pagina stessa è servita in HTTP semplice. In sviluppo locale
// (anche via LAN, es. http://192.168.x.x:3000) il server Node non espone
// TLS sulla stessa porta: il browser tenta quindi https://<host>:3000/... e
// fallisce (nessun listener TLS), lasciando pagina priva di CSS/immagini
// senza errori visibili all'utente. In produzione su Render il traffico
// pubblico è servito in HTTPS dal load balancer, quindi la direttiva va
// mantenuta lì. Impostare la chiave a null (anziché omettendola) è il modo
// supportato da Helmet per escluderla esplicitamente dai default uniti.
const isProduction = process.env.NODE_ENV === 'production';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://api.stripe.com'],
      frameSrc: ['https://js.stripe.com', 'https://checkout.stripe.com'],
      // La chiave va omessa (produzione, default Helmet attivo) oppure
      // impostata esplicitamente a null (sviluppo, direttiva esclusa):
      // passare "undefined" qui farebbe fallire Helmet con un errore.
      ...(isProduction ? {} : { upgradeInsecureRequests: null }),
    },
  },
}));

app.use(cors({
  origin: FRONTEND_URL,
  methods: ['GET', 'POST'],
}));

const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Troppe richieste. Riprova più tardi.' },
});
app.use('/api/', apiLimiter);

// ---------------------------------------------------------------------
// Stripe webhook richiede il body RAW (deve essere registrato PRIMA
// del parser JSON globale, che altrimenti corromperebbe la firma).
// ---------------------------------------------------------------------
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// Parser JSON per tutte le altre rotte
app.use(express.json({ limit: '1mb' }));

// Cookie parser: serve a leggere il cookie di sessione httpOnly impostato
// dopo il login via Magic Link (vedi src/services/authService.js). Il
// cookie contiene un JWT firmato, non serve un secret qui: la verifica
// della firma avviene dentro authService con SESSION_SECRET.
app.use(cookieParser());

// ---------------------------------------------------------------------
// File statici (frontend)
// ---------------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------
// Config pubblica (non sensibile) per il frontend
// ---------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  const testMode = process.env.TEST_MODE === 'true';
  res.json({
    maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 10,
    maxFilesPerRequest: parseInt(process.env.MAX_FILES_PER_REQUEST, 10) || 10,
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
    // "waitlist" (default, pre-lancio senza Partita IVA attiva): i piani a
    // pagamento raccolgono l'interesse invece di avviare un vero checkout.
    // "live": comportamento normale, checkout Stripe reale.
    launchMode: process.env.LAUNCH_MODE === 'live' ? 'live' : 'waitlist',
    // TEST_MODE beta configuration
    testMode,
    testDailyLimit: testMode ? getTestDailyLimit() : null,
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------
// Rotte API
// ---------------------------------------------------------------------
app.use('/api/extract', extractRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/waitlist', waitlistRoutes);
app.use('/api/feedback', feedbackRoutes);

// ---------------------------------------------------------------------
// 404 + error handler
// ---------------------------------------------------------------------
app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log('[server] configuration', JSON.stringify(startupSummary(process.env, getTestDailyLimit(), require('./middleware/upload'))));
  console.log(`Invoice Extractor server in ascolto sulla porta ${PORT}`);
});

module.exports = app;
