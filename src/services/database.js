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
const DB_PATH = path.join(DATA_DIR, 'invoice-extractor.sqlite');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
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

const statements = {
  getUser: db.prepare('SELECT * FROM users WHERE user_id = ?'),
  getUserByCustomerId: db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?'),
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
};

function getUser(userId) {
  return statements.getUser.get(userId) || null;
}

function getUserByCustomerId(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  return statements.getUserByCustomerId.get(stripeCustomerId) || null;
}

function insertUser(user) {
  statements.insertUser.run(user);
}

function saveUser(user) {
  statements.updateUser.run(user);
}

module.exports = {
  db,
  getUser,
  getUserByCustomerId,
  insertUser,
  saveUser,
};
