// Synthetic multi-process SQLite race worker; never defaults to the live DB.
if (!process.env.TEST_DB_PATH || !process.send) throw new Error('Isolated test DB and IPC required');
const database = require('../../src/services/database');
process.send('ready');
process.once('message', ({ userId, day }) => {
  try {
    process.send(database.atomicReserveTestUsage(userId, day, 8, 50, 20));
  } finally { database.db.close(); process.disconnect(); }
});
