require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const extractRoutes = require('./routes/extract');
const exportRoutes = require('./routes/export');
const stripeRoutes = require('./routes/stripe');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || `http://localhost:${PORT}`;

// ---------------------------------------------------------------------
// Sicurezza baseline
// ---------------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.tailwindcss.com', 'https://cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://api.stripe.com'],
      frameSrc: ['https://js.stripe.com', 'https://checkout.stripe.com'],
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

// ---------------------------------------------------------------------
// File statici (frontend)
// ---------------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------
// Config pubblica (non sensibile) per il frontend
// ---------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({
    maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 10,
    maxFilesPerRequest: parseInt(process.env.MAX_FILES_PER_REQUEST, 10) || 10,
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
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

// ---------------------------------------------------------------------
// 404 + error handler
// ---------------------------------------------------------------------
app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Invoice Extractor server in ascolto sulla porta ${PORT}`);
});

module.exports = app;
