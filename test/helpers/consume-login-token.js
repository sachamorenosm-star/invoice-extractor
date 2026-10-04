// Independent SQLite connection/process for the single-use race regression.
require('./offline');
const authService = require('../../src/services/authService');
const database = require('../../src/services/database');
process.send({ ready: true });
process.on('message', ({ token }) => {
  const consumed = !!authService.verifyLoginToken(token);
  database.db.close();
  process.send({ consumed }, () => process.exit(0));
});
