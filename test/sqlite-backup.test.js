const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { ACTIVE_DB, REQUIRED_TABLES, createBackup, verifyBackup, restoreBackup } = require('../src/utils/sqliteBackup');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-backup-test-'));
process.env.TEST_DB_PATH = path.join(directory, 'synthetic.sqlite');
const { db } = require('../src/services/database');
let pass = 0;
function check(name, fn) { fn(); pass++; console.log(`PASS ${name}`); }
async function rejects(name, fn, code) {
  await assert.rejects(fn, code ? { code } : undefined);
  pass++; console.log(`PASS ${name}`);
}
function rows(connection) {
  return Object.fromEntries(REQUIRED_TABLES.map(table => [table, connection.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()]));
}
function cli(args) { return spawnSync(process.execPath, ['scripts/sqlite-backup.js', ...args], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }); }

async function main() {
  check('isolated source path', () => assert.equal(db.name, process.env.TEST_DB_PATH));
  check('source is not live DB', () => assert.notEqual(path.resolve(db.name), ACTIVE_DB));
  check('WAL enabled', () => assert.equal(db.pragma('journal_mode', { simple: true }), 'wal'));
  db.pragma('wal_autocheckpoint = 0');
  db.pragma('wal_checkpoint(TRUNCATE)');
  const mainBefore = fs.readFileSync(db.name);
  db.transaction(() => {
    db.prepare("INSERT INTO users VALUES ('synthetic-user','free',7,'2026-10',NULL,NULL,'tester@example.invalid',NULL)").run();
    db.prepare("INSERT INTO login_tokens VALUES (?, 'tester@example.invalid','synthetic-user',2000000000000,0)").run('a'.repeat(64));
    db.prepare("INSERT INTO test_usage VALUES ('synthetic-user','2026-10-04',9,1000)").run();
    db.prepare("INSERT INTO waitlist_signups(email,plan,created_at) VALUES ('wait@example.invalid','starter',1000)").run();
    db.prepare("INSERT INTO feedback_signals(usefulness_rating,would_pay,optional_email,created_at) VALUES ('useful','yes',NULL,1000)").run();
  })();
  check('committed writes still in WAL, main unchanged', () => assert.deepEqual(fs.readFileSync(db.name), mainBefore));
  check('WAL has committed content', () => assert.ok(fs.statSync(db.name + '-wal').size > 32));
  const expected = rows(db);
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  const backup = await createBackup(db, { backupDir: path.join(directory, 'backups') });
  check('backup created', () => assert.ok(fs.statSync(backup.path).size > 0));
  check('backup separate from source', () => assert.notEqual(backup.path, path.resolve(db.name)));
  check('safe unique filename', () => assert.match(path.basename(backup.path), /^invoice-extractor-\d{8}-\d{6}Z-[a-f0-9-]+\.sqlite$/));
  check('integrity ok', () => assert.equal(backup.integrity, 'ok'));
  check('core tables verified', () => assert.deepEqual(backup.tables, REQUIRED_TABLES));
  check('metadata excludes record values', () => assert.ok(!JSON.stringify(backup).includes('tester@')));
  const copied = new Database(backup.path, { readonly: true, fileMustExist: true });
  try {
    check('schema unchanged', () => assert.deepEqual(copied.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(), schema));
    for (const table of REQUIRED_TABLES) check(`${table} count and values including WAL preserved`, () => assert.deepEqual(rows(copied)[table], expected[table]));
    check('standalone DELETE journal', () => assert.equal(copied.pragma('journal_mode', { simple: true }), 'delete'));
  } finally { copied.close(); }
  check('backup has no WAL sidecar', () => assert.ok(!fs.existsSync(backup.path + '-wal')));
  const destination = path.join(directory, 'restored.sqlite');
  const restored = await restoreBackup(backup.path, destination);
  check('restore is separate and verified', () => { assert.equal(restored.path, destination); assert.equal(restored.integrity, 'ok'); });
  const recovered = new Database(destination, { readonly: true });
  try { check('restore preserves every record', () => assert.deepEqual(rows(recovered), expected)); }
  finally { recovered.close(); }
  await rejects('existing restore refused', () => restoreBackup(backup.path, destination), 'EEXIST');
  await rejects('source overwrite refused', () => restoreBackup(backup.path, backup.path), 'BACKUP_DESTINATION_PROTECTED');
  await rejects('live production destination refused without opening it', () => restoreBackup(backup.path, ACTIVE_DB), 'BACKUP_DESTINATION_PROTECTED');
  await rejects('source WAL overwrite refused', () => restoreBackup(backup.path, backup.path + '-wal'), 'BACKUP_DESTINATION_PROTECTED');
  await rejects('missing source refused', () => restoreBackup(path.join(directory, 'missing.sqlite'), path.join(directory, 'missing-restore.sqlite')), 'BACKUP_SOURCE_MISSING');
  check('missing source never created', () => assert.ok(!fs.existsSync(path.join(directory, 'missing.sqlite'))));
  const invalid = path.join(directory, 'invalid.sqlite'); fs.writeFileSync(invalid, 'not a database');
  check('invalid verification fails', () => assert.throws(() => verifyBackup(invalid)));
  await rejects('invalid restore fails', () => restoreBackup(invalid, path.join(directory, 'invalid-restore.sqlite')));
  check('invalid restore destination absent', () => assert.ok(!fs.existsSync(path.join(directory, 'invalid-restore.sqlite'))));
  const empty = new Database(path.join(directory, 'empty.sqlite')); empty.exec('CREATE TABLE other(id)'); empty.close();
  check('missing required schema fails', () => assert.throws(() => verifyBackup(path.join(directory, 'empty.sqlite')), { code: 'BACKUP_SCHEMA_MISSING' }));
  const sidecarTarget = path.join(directory, 'sidecar.sqlite'); fs.writeFileSync(sidecarTarget + '-wal', 'existing');
  await rejects('existing sidecar refused', () => restoreBackup(backup.path, sidecarTarget), 'BACKUP_DESTINATION_SIDECAR_EXISTS');
  check('existing sidecar intact', () => assert.equal(fs.readFileSync(sidecarTarget + '-wal', 'utf8'), 'existing'));
  const second = await createBackup(db, { backupDir: path.join(directory, 'backups') });
  check('successive backups never overwrite', () => assert.notEqual(second.path, backup.path));
  check('CLI verify success', () => assert.equal(cli(['verify', '--source', backup.path]).status, 0));
  check('CLI source required for verification', () => assert.equal(cli(['verify']).status, 1));
  check('CLI restore destination required', () => assert.equal(cli(['restore', '--source', backup.path]).status, 1));
  check('CLI backup explicit isolated source', () => assert.equal(cli(['backup', '--source', db.name, '--backup-dir', path.join(directory, 'cli-backups')]).status, 0));
  check('CLI restore explicit new file', () => assert.equal(cli(['restore', '--source', backup.path, '--destination', path.join(directory, 'cli-restored.sqlite')]).status, 0));
  check('CLI rejects overwrite', () => assert.equal(cli(['restore', '--source', backup.path, '--destination', destination]).status, 1));
  check('original records unchanged', () => assert.deepEqual(rows(db), expected));
  check('original main remains uncheckpointed', () => assert.deepEqual(fs.readFileSync(db.name), mainBefore));
  console.log(`PASS: ${pass}\nFAIL: 0\nSKIPPED: 0`);
}

main().catch(error => { console.error(error); console.log(`PASS: ${pass}\nFAIL: 1\nSKIPPED: 0`); process.exitCode = 1; }).finally(() => {
  db.close();
  // This directory was created by this test, under the system temp root.
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('invoice-backup-test-')) throw new Error('Unsafe cleanup path');
  fs.rmSync(directory, { recursive: true, force: true });
});
