#!/usr/bin/env node
require('dotenv').config();
const { ACTIVE_DB, createBackup, verifyBackup, restoreBackup, openSource } = require('../src/utils/sqliteBackup');

async function main(args) {
  const [command, ...rest] = args;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (!['--source', '--destination', '--backup-dir'].includes(key) || !rest[index + 1] || options[key]) throw new Error('CLI_ARGUMENTS_INVALID');
    options[key] = rest[index + 1];
  }
  let result;
  if (command === 'backup' && !options['--destination']) {
    const db = openSource(options['--source'] || ACTIVE_DB);
    try { result = await createBackup(db, { backupDir: options['--backup-dir'] }); }
    finally { db.close(); }
  } else if (command === 'verify' && options['--source'] && !options['--destination'] && !options['--backup-dir']) {
    result = verifyBackup(options['--source']);
  } else if (command === 'restore' && options['--source'] && options['--destination'] && !options['--backup-dir']) {
    result = await restoreBackup(options['--source'], options['--destination']);
  } else {
    throw new Error('CLI_ARGUMENTS_INVALID');
  }
  console.log(JSON.stringify(result));
}

main(process.argv.slice(2)).catch(() => {
  console.error('SQLite operation failed: check arguments, source integrity, permissions and a new separate destination.');
  process.exitCode = 1;
});
