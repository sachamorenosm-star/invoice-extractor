const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const database = require('./database');

// -----------------------------------------------------------------------
// Autenticazione senza password, basata su "Magic Link" via email:
// 1. L'utente chiede l'accesso con la propria email.
// 2. Generiamo un token monouso valido 15 minuti e lo inviamo via Resend.
// 3. Cliccando il link, il token viene verificato e viene emessa una
//    sessione (cookie httpOnly firmato con un JWT).
//
// Nessuna password viene mai richiesta, salvata o gestita.
// -----------------------------------------------------------------------

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minuti
const SESSION_TTL = '30d';
const SESSION_COOKIE = 'ie_session';
const DEFAULT_SESSION_SECRET = 'change-this-to-a-long-random-string';
const PLACEHOLDER_SESSION_SECRET = 'replace-with-a-secure-random-secret';

const EMAIL_FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Validazione SESSION_SECRET con behavior diverso tra dev e production
let JWT_SECRET;

if (!process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET === DEFAULT_SESSION_SECRET ||
    process.env.SESSION_SECRET === PLACEHOLDER_SESSION_SECRET) {

  if (NODE_ENV === 'production') {
    console.error('[authService] ERRORE CRITICO: SESSION_SECRET non configurato, vuoto, o usa il valore di placeholder noto.');
    console.error('[authService] In production, SESSION_SECRET deve essere obbligatorio e casuale (min 32 caratteri).');
    console.error('[authService] Genera un nuovo secret con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  } else {
    // Development: genera automaticamente
    JWT_SECRET = crypto.randomBytes(32).toString('hex');
    // Mai loggare nemmeno una parte del secret di firma.
    console.warn('[authService] SESSION_SECRET non configurato in development: generato un secret temporaneo (le sessioni si azzerano al riavvio).');
  }
} else if (process.env.SESSION_SECRET.length < 32) {
  if (NODE_ENV === 'production') {
    console.error('[authService] ERRORE CRITICO: SESSION_SECRET è troppo corta (min 32 caratteri).');
    process.exit(1);
  } else {
    console.warn('[authService] SESSION_SECRET è corta (<32 chars). Usa una stringa più lunga per production.');
    JWT_SECRET = process.env.SESSION_SECRET;
  }
} else {
  JWT_SECRET = process.env.SESSION_SECRET;
}

// Il client Resend viene creato solo se una chiave è configurata: senza,
// l'invio fallisce in modo gestito (loggato) invece di far crashare il
// server all'avvio o durante la richiesta.
const resend = process.env.RESEND_API_KEY && process.env.RESEND_API_KEY !== 're_xxxxxxxxxxxxxxxxxxxxxxxx'
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

if (!resend) {
  console.warn('[authService] RESEND_API_KEY assente o placeholder: l\'invio reale delle email di accesso è disabilitato (funzionalità degradata, nessun crash).');
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_PATTERN.test(email.trim());
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

// Il token del Magic Link è una credenziale bearer temporanea: non deve mai
// finire nei log (né in produzione né in sviluppo). Per i log usiamo solo
// metadati non segreti: email mascherata e un URL con il token oscurato.
const SAFE_VERIFY_HINT = '/api/auth/verify?token=[REDACTED]';

function maskEmail(email) {
  const [local, domain] = normalizeEmail(email).split('@');
  return `${(local || '').slice(0, 1)}***@${domain || '?'}`;
}

// Difesa in profondità per i messaggi d'errore di terze parti (es. Resend)
// che potrebbero riecheggiare il corpo dell'email: oscura "token=<valore>"
// e qualsiasi sequenza esadecimale lunga (formato dei nostri token).
function redactSecrets(text) {
  return String(text)
    .replace(/token=[^\s&"'<>]+/gi, 'token=[REDACTED]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[REDACTED]');
}

function currentPeriodKey() {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth()}`;
}

/**
 * Crea un token di accesso casuale sicuro (256 bit), lo salva con
 * scadenza a 15 minuti e lo restituisce. Non invia nulla: usato anche
 * direttamente nei test.
 */
function generateLoginToken(email, anonUserId) {
  const token = crypto.randomBytes(32).toString('hex');
  database.insertLoginToken({
    token,
    email: normalizeEmail(email),
    anon_user_id: anonUserId || null,
    expires_at: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

/**
 * Genera il token e invia l'email con il link di accesso tramite Resend.
 * Se Resend non è configurato, o l'invio fallisce, non lancia mai
 * un'eccezione verso il chiamante: logga l'accaduto e restituisce
 * { sent: false }. La rotta che la usa risponde comunque con successo
 * generico, per non rivelare se l'email esiste nel sistema.
 */
async function sendMagicLink(email, anonUserId) {
  const token = generateLoginToken(email, anonUserId);
  const verifyUrl = `${FRONTEND_URL}/api/auth/verify?token=${token}`;

  if (!resend) {
    console.warn(`[authService] Magic-link generato per ${maskEmail(email)}: invio saltato (provider email non configurato). Link: ${SAFE_VERIFY_HINT}`);
    return { sent: false };
  }

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: normalizeEmail(email),
      subject: 'Il tuo link di accesso a InvoiceExtract',
      text: [
        'Ciao,',
        '',
        'Clicca sul link qui sotto per accedere a InvoiceExtract.',
        'Il link è valido per 15 minuti e può essere usato una sola volta:',
        '',
        verifyUrl,
        '',
        "Se non hai richiesto tu l'accesso, ignora pure questa email: nessuna azione verrà eseguita sul tuo account.",
        '',
        '— InvoiceExtract',
      ].join('\n'),
    });
    return { sent: true };
  } catch (err) {
    // Non logghiamo mai l'indirizzo email per intero nei log applicativi.
    const safeMessage = redactSecrets(err && err.message);
    console.error('[authService] Errore invio email tramite Resend:', safeMessage);
    return { sent: false, error: safeMessage };
  }
}

/**
 * Verifica un token: deve esistere, non essere scaduto, non essere già
 * stato usato. Se valido, lo marca immediatamente come usato (monouso) e
 * restituisce { email, anonUserId }. Altrimenti restituisce null.
 */
function verifyLoginToken(token) {
  if (!token) return null;
  const row = database.getLoginToken(token);
  if (!row) return null;
  if (row.used) return null;
  if (row.expires_at < Date.now()) return null;

  database.markLoginTokenUsed(token);
  return { email: row.email, anonUserId: row.anon_user_id || null };
}

/**
 * Trova l'account per questa email oppure ne crea uno nuovo. Se l'utente
 * non ha ancora un account con questa email ma possiede già un profilo
 * anonimo (X-User-Id) con piano/pagine già in uso, quel profilo viene
 * "adottato" come account autenticato, preservando piano e scansioni.
 */
function findOrCreateUserForEmail(email, anonUserId) {
  const normalizedEmail = normalizeEmail(email);

  const existing = database.getUserByEmail(normalizedEmail);
  if (existing) {
    return existing.user_id;
  }

  if (anonUserId) {
    const anonRow = database.getUser(anonUserId);
    if (anonRow && !anonRow.email) {
      database.updateUserAuth({
        user_id: anonUserId,
        email: normalizedEmail,
        recovery_email: anonRow.recovery_email || null,
      });
      return anonUserId;
    }
  }

  const newUserId = `usr_${crypto.randomUUID()}`;
  database.insertUser({
    user_id: newUserId,
    tier: 'free',
    scans_used: 0,
    period_key: currentPeriodKey(),
    stripe_customer_id: null,
    stripe_subscription_id: null,
  });
  database.updateUserAuth({ user_id: newUserId, email: normalizedEmail, recovery_email: null });
  return newUserId;
}

function createSessionToken(userId, email) {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: SESSION_TTL });
}

function verifySessionToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

function setSessionCookie(res, userId, email) {
  const token = createSessionToken(userId, email);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE);
}

/**
 * Legge ed eventualmente valida la sessione dal cookie della richiesta.
 * Richiede che `cookie-parser` sia montato globalmente (vedi server.js).
 */
function getSessionFromRequest(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  return verifySessionToken(token);
}

/**
 * Imposta/aggiorna l'email di recupero secondaria per un utente già
 * autenticato. Non tocca mai l'email principale.
 */
function setRecoveryEmail(userId, recoveryEmail) {
  const user = database.getUser(userId);
  if (!user) {
    throw Object.assign(new Error('Utente non trovato.'), { status: 404 });
  }
  database.updateUserAuth({
    user_id: userId,
    email: user.email,
    recovery_email: recoveryEmail || null,
  });
}

module.exports = {
  SESSION_COOKIE,
  isValidEmail,
  generateLoginToken,
  sendMagicLink,
  verifyLoginToken,
  findOrCreateUserForEmail,
  setSessionCookie,
  clearSessionCookie,
  getSessionFromRequest,
  setRecoveryEmail,
};
