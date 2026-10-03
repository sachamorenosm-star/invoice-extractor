const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// -----------------------------------------------------------------------
// Persistenza SQLite per lo stato utenti/abbonamenti (piano, contatore di
// scansioni, collegamento con Stripe). Scelta adatta a un MVP self-hosted:
// un singolo file su disco, nessun servizio esterno da gestire.
//
// NOTA: NON contiene mai dati delle fatture/ricevute caricate dagli utenti
// (quelli restano zero-retention, solo in RAM durante la richiesta) — qui
// viviamo solo id utente anonimo, piano e contatore di utilizzo mensile.
// -----------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
// TEST_DB_PATH: usato SOLO dai test automatici per puntare a un file SQLite
// isolato e temporaneo, senza mai toccare il database reale. Non impostata
// in produzione: il comportamento di default resta identico a prima.
const DB_PATH = process.env.TEST_DB_PATH || path.join(DATA_DIR, 'invoice-extractor.sqlite');

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    tier TEXT NOT NULL DEFAULT 'free',
    scans_used INTEGER NOT NULL DEFAULT 0,
    period_key TEXT NOT NULL,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_users_stripe_customer_id
  ON users (stripe_customer_id);
`);

// ---------------------------------------------------------------------
// Migrazione leggera: aggiunge le colonne "email"/"recovery_email" a un
// database già esistente (creato prima dell'introduzione del login via
// Magic Link) senza distruggere i dati già presenti. ALTER TABLE ADD
// COLUMN fallisce se la colonna esiste già, quindi controlliamo prima.
// ---------------------------------------------------------------------
function ensureColumn(table, column, definition) {
  const existingColumns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!existingColumns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('users', 'email', 'TEXT');
ensureColumn('users', 'recovery_email', 'TEXT');

// Indice univoco parziale: l'email deve essere unica quando presente, ma
// gli utenti anonimi (email NULL) restano illimitati e non in conflitto
// tra loro.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
  ON users (email) WHERE email IS NOT NULL;
`);

// ---------------------------------------------------------------------
// Token di accesso "Magic Link": monouso, scadenza breve (15 minuti),
// mai persistiti in chiaro nei log. anon_user_id collega opzionalmente
// il login al profilo anonimo (piano/pagine) già esistente nel browser,
// per la migrazione automatica al primo accesso (vedi authService.js).
// ---------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS login_tokens (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    anon_user_id TEXT,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_login_tokens_email
  ON login_tokens (email);
`);

// ---------------------------------------------------------------------
// Lista d'attesa (modalità pre-lancio, LAUNCH_MODE=waitlist): registra
// l'interesse per un piano senza processare alcun pagamento reale.
// ---------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS waitlist_signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    plan TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_waitlist_signups_email
  ON waitlist_signups (email);
`);

// ---------------------------------------------------------------------
// Segnali di feedback dal micro-sondaggio post-estrazione: nessun
// collegamento ai dati delle fatture elaborate, solo il segnale in
// forma aggregata/anonima (email solo se lasciata volontariamente).
// ---------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS feedback_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usefulness_rating TEXT NOT NULL,
    would_pay TEXT NOT NULL,
    optional_email TEXT,
    created_at INTEGER NOT NULL
  );
`);

// ---------------------------------------------------------------
// TEST_MODE beta usage tracking: per-user daily page quota.
// Completely separate from monthly paid plan accounting.
// ---------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS test_usage (
    user_id TEXT NOT NULL,
    date_key TEXT NOT NULL,
    pages_used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, date_key)
  );
`);

const statements = {
  getUser: db.prepare('SELECT * FROM users WHERE user_id = ?'),
  getUserByCustomerId: db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?'),
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  insertUser: db.prepare(`
    INSERT INTO users (user_id, tier, scans_used, period_key, stripe_customer_id, stripe_subscription_id)
    VALUES (@user_id, @tier, @scans_used, @period_key, @stripe_customer_id, @stripe_subscription_id)
  `),
  updateUser: db.prepare(`
    UPDATE users SET
      tier = @tier,
      scans_used = @scans_used,
      period_key = @period_key,
      stripe_customer_id = @stripe_customer_id,
      stripe_subscription_id = @stripe_subscription_id
    WHERE user_id = @user_id
  `),
  updateUserAuth: db.prepare(`
    UPDATE users SET email = @email, recovery_email = @recovery_email
    WHERE user_id = @user_id
  `),
  insertLoginToken: db.prepare(`
    INSERT INTO login_tokens (token, email, anon_user_id, expires_at, used)
    VALUES (@token, @email, @anon_user_id, @expires_at, 0)
  `),
  getLoginToken: db.prepare('SELECT * FROM login_tokens WHERE token = ?'),
  markLoginTokenUsed: db.prepare('UPDATE login_tokens SET used = 1 WHERE token = ?'),
  insertWaitlistSignup: db.prepare(`
    INSERT INTO waitlist_signups (email, plan, created_at)
    VALUES (@email, @plan, @created_at)
  `),
  insertFeedbackSignal: db.prepare(`
    INSERT INTO feedback_signals (usefulness_rating, would_pay, optional_email, created_at)
    VALUES (@usefulness_rating, @would_pay, @optional_email, @created_at)
  `),
  getTestUsage: db.prepare('SELECT pages_used FROM test_usage WHERE user_id = ? AND date_key = ?'),
  upsertTestUsage: db.prepare(`
    INSERT INTO test_usage (user_id, date_key, pages_used, created_at)
    VALUES (@user_id, @date_key, @pages_used, @created_at)
    ON CONFLICT(user_id, date_key) DO UPDATE SET
      pages_used = pages_used + @pages_used
  `),
  setTestUsagePages: db.prepare(`
    UPDATE test_usage SET pages_used = @pages_used
    WHERE user_id = @user_id AND date_key = @date_key
  `),
  insertTestUsageIfNotExists: db.prepare(`
    INSERT OR IGNORE INTO test_usage (user_id, date_key, pages_used, created_at)
    VALUES (@user_id, @date_key, 0, @created_at)
  `),
};

function getUser(userId) {
  return statements.getUser.get(userId) || null;
}

function getUserByCustomerId(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  return statements.getUserByCustomerId.get(stripeCustomerId) || null;
}

function getUserByEmail(email) {
  if (!email) return null;
  return statements.getUserByEmail.get(email) || null;
}

function insertUser(user) {
  statements.insertUser.run(user);
}

function saveUser(user) {
  statements.updateUser.run(user);
}

function updateUserAuth({ user_id: userId, email, recovery_email: recoveryEmail }) {
  statements.updateUserAuth.run({ user_id: userId, email: email || null, recovery_email: recoveryEmail || null });
}

function insertLoginToken({ token, email, anon_user_id: anonUserId, expires_at: expiresAt }) {
  statements.insertLoginToken.run({ token, email, anon_user_id: anonUserId || null, expires_at: expiresAt });
}

function getLoginToken(token) {
  return statements.getLoginToken.get(token) || null;
}

function markLoginTokenUsed(token) {
  statements.markLoginTokenUsed.run(token);
}

function insertWaitlistSignup({ email, plan }) {
  statements.insertWaitlistSignup.run({ email, plan, created_at: Date.now() });
}

function insertFeedbackSignal({ usefulness_rating: usefulnessRating, would_pay: wouldPay, optional_email: optionalEmail }) {
  statements.insertFeedbackSignal.run({
    usefulness_rating: usefulnessRating,
    would_pay: wouldPay,
    optional_email: optionalEmail || null,
    created_at: Date.now(),
  });
}

// TEST_MODE beta usage tracking (separate from monthly paid accounting)
function getTestUsage(userId, dateKey) {
  const row = statements.getTestUsage.get(userId, dateKey);
  return row ? row.pages_used : 0;
}

function atomicReserveTestUsage(userId, dateKey, count, limit) {
  const transaction = db.transaction(() => {
    statements.insertTestUsageIfNotExists.run({ user_id: userId, date_key: dateKey, created_at: Date.now() });
    const current = statements.getTestUsage.get(userId, dateKey);
    const used = current ? current.pages_used : 0;

    // Atomic check: if adding count would exceed limit, reject reservation
    if (used + count > limit) {
      return { success: false, used };
    }

    // Atomic increment: reserve the pages
    statements.upsertTestUsage.run({ user_id: userId, date_key: dateKey, pages_used: count, created_at: Date.now() });

    return { success: true, used: used + count };
  });

  return transaction();
}

function incrementTestUsage(userId, dateKey, count) {
  const current = statements.getTestUsage.get(userId, dateKey);
  if (!current) {
    statements.insertTestUsageIfNotExists.run({ user_id: userId, date_key: dateKey, created_at: Date.now() });
  }
  statements.upsertTestUsage.run({ user_id: userId, date_key: dateKey, pages_used: count, created_at: Date.now() });
}

function decrementTestUsage(userId, dateKey, count) {
  const current = statements.getTestUsage.get(userId, dateKey);
  if (!current) return;  // Nothing to decrement

  const newValue = Math.max(0, current.pages_used - count);
  statements.setTestUsagePages.run({ user_id: userId, date_key: dateKey, pages_used: newValue });
}

module.exports = {
  db,
  getUser,
  getUserByCustomerId,
  getUserByEmail,
  insertUser,
  saveUser,
  updateUserAuth,
  insertLoginToken,
  getLoginToken,
  markLoginTokenUsed,
  insertWaitlistSignup,
  insertFeedbackSignal,
  getTestUsage,
  atomicReserveTestUsage,
  incrementTestUsage,
  decrementTestUsage,
};
