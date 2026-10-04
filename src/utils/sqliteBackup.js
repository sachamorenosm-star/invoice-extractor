const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '../..');
const ACTIVE_DB = path.join(ROOT, 'data/invoice-extractor.sqlite');
const REQUIRED_TABLES = Object.freeze(['users', 'login_tokens', 'test_usage', 'waitlist_signups', 'feedback_signals']);

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function openSource(source) {
  if (typeof source !== 'string' || !source.trim() || !fs.statSync(source, { throwIfNoEntry: false })?.isFile()) {
    throw failure('BACKUP_SOURCE_MISSING');
  }
  return new Database(path.resolve(source), { readonly: true, fileMustExist: true });
}

function inspect(db) {
  const integrity = db.pragma('integrity_check');
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw failure('BACKUP_INTEGRITY_FAILED');
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
  if (REQUIRED_TABLES.some(table => !tables.has(table))) throw failure('BACKUP_SCHEMA_MISSING');
  return { integrity: 'ok', tables: [...REQUIRED_TABLES] };
}

function verifyBackup(source) {
  const db = openSource(source);
  try { return { path: path.resolve(source), ...inspect(db) }; }
  finally { db.close(); }
}

function reserve(destination, sourceName) {
  const target = path.resolve(destination);
  const protectedPaths = [ACTIVE_DB, sourceName].filter(Boolean).flatMap(name => [name, `${name}-wal`, `${name}-shm`, `${name}-journal`]);
  if (protectedPaths.some(name => path.resolve(name).toLowerCase() === target.toLowerCase())) {
    throw failure('BACKUP_DESTINATION_PROTECTED');
  }
  // Exclusive creation also rejects existing files, symlinks and hardlinks.
  if (['-wal', '-shm', '-journal'].some(suffix => fs.existsSync(target + suffix))) throw failure('BACKUP_DESTINATION_SIDECAR_EXISTS');
  const fd = fs.openSync(target, 'wx', 0o600);
  fs.closeSync(fd);
  return target;
}

async function copySnapshot(db, destination) {
  try {
    await db.backup(destination);
    // Publish a standalone SQLite file, without a required WAL sidecar.
    const output = new Database(destination, { fileMustExist: true });
    try {
      if (output.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') throw failure('BACKUP_STANDALONE_FAILED');
      inspect(output);
    } finally { output.close(); }
    return { ...verifyBackup(destination), bytes: fs.statSync(destination).size };
  } catch (error) {
    // Only files exclusively created by this invocation are removed.
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(destination + suffix, { force: true });
    throw error;
  }
}

async function createBackup(db, { backupDir = process.env.BACKUP_DIR || path.join(ROOT, 'data/backups') } = {}) {
  if (!db?.open || typeof db.backup !== 'function' || db.inTransaction) throw failure('BACKUP_CONNECTION_INVALID');
  const directory = path.resolve(backupDir);
  fs.mkdirSync(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-');
  const destination = reserve(path.join(directory, `invoice-extractor-${timestamp}-${randomUUID()}.sqlite`), db.name);
  return copySnapshot(db, destination);
}

async function restoreBackup(source, destination) {
  if (typeof destination !== 'string' || !destination.trim()) throw failure('RESTORE_DESTINATION_REQUIRED');
  const db = openSource(source);
  try {
    inspect(db);
    const target = reserve(destination, db.name);
    return await copySnapshot(db, target);
  } finally { db.close(); }
}

module.exports = { ACTIVE_DB, REQUIRED_TABLES, createBackup, verifyBackup, restoreBackup, openSource };
