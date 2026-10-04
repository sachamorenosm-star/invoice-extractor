const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
require('./helpers/offline');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-quota-config-'));
Object.assign(process.env, {
  TEST_DB_PATH: path.join(directory, 'synthetic.sqlite'), TEST_MODE: 'true',
  TEST_DAILY_EXTRACTION_LIMIT: '20', TEST_GLOBAL_DAILY_EXTRACTION_LIMIT: '50', NODE_ENV: 'production',
});
const config = require('../src/utils/config');
const service = require('../src/services/stripeService');
const database = require('../src/services/database');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('PASS: ' + name); }
  catch (error) { fail++; console.error('FAIL: ' + name, error); }
  finally { process.env.TEST_MODE = 'true'; process.env.TEST_DAILY_EXTRACTION_LIMIT = '20'; }
}
// Disable dotenv only in this isolated child so a missing variable cannot be
// silently supplied by an operator's .env. Close the ephemeral server on startup.
const startup = `require('dotenv').config = () => ({});
const express = require('express'); const original = express.application.listen;
express.application.listen = function(...args) {
  const server = original.apply(this, args);
  server.once('listening', () => server.close(() => require('./src/services/database').db.close()));
  return server;
}; require('./src/server');`;
let index = 0;
function start(raw) {
  const target = path.join(directory, 'startup-' + (++index) + '.sqlite');
  const env = { ...process.env, NODE_ENV: 'production', TEST_MODE: 'true', TEST_DB_PATH: target, PORT: '0',
    TEST_GLOBAL_DAILY_EXTRACTION_LIMIT: '50', TEST_DAILY_EXTRACTION_LIMIT: raw,
    SESSION_SECRET: 'quota-config-synthetic-session-secret-32-plus', BETA_ALLOWED_EMAILS: 'synthetic@example.invalid',
    ANTHROPIC_API_KEY: '', RESEND_API_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' };
  if (raw === undefined) delete env.TEST_DAILY_EXTRACTION_LIMIT;
  return { ...spawnSync(process.execPath, ['-e', startup], { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 10000 }), target };
}
try {
  for (const raw of [undefined, '', '0', '-1', '1.5', '01.5', 'abc', '50abc', 'NaN', 'Infinity', '  ', 'True', '50\n', '50 ', '9007199254740992']) {
    test('invalid quota fails parser, runtime and production startup: ' + JSON.stringify(raw), () => {
      for (const NODE_ENV of ['production', 'development', 'test']) {
        assert.throws(() => config.getTestDailyLimit({ TEST_MODE: 'true', NODE_ENV, TEST_DAILY_EXTRACTION_LIMIT: raw }), /TEST_DAILY_EXTRACTION_LIMIT/);
      }
      if (raw === undefined) delete process.env.TEST_DAILY_EXTRACTION_LIMIT;
      else process.env.TEST_DAILY_EXTRACTION_LIMIT = raw;
      assert.throws(() => service.getTestDailyLimit(), /TEST_DAILY_EXTRACTION_LIMIT/);
      const result = start(raw);
      assert.notEqual(result.status, 0); assert.match(result.stderr, /Invalid TEST_DAILY_EXTRACTION_LIMIT/);
      assert.ok(!result.stdout.includes('[server] configuration')); assert.ok(!fs.existsSync(result.target));
      assert.ok(!result.stderr.includes('quota-config-synthetic-session-secret'));
      if (raw) assert.ok(!result.stderr.includes('Invalid TEST_DAILY_EXTRACTION_LIMIT=' + raw));
    });
  }
  for (const raw of ['1', '5', '20', '50']) {
    test('positive quota accepted at startup and runtime: ' + raw, () => {
      process.env.TEST_DAILY_EXTRACTION_LIMIT = raw;
      assert.equal(config.getTestDailyLimit(), Number(raw)); assert.equal(service.getTestDailyLimit(), Number(raw));
      const result = start(raw); assert.equal(result.status, 0, result.stderr);
      const line = result.stdout.split(/\r?\n/).find(line => line.startsWith('[server] configuration '));
      const summary = JSON.parse(line.slice('[server] configuration '.length));
      assert.equal(summary.TEST_DAILY_EXTRACTION_LIMIT, Number(raw)); assert.equal(summary.TEST_GLOBAL_DAILY_EXTRACTION_LIMIT, 50);
    });
  }
  test('valid quota enforces exact boundary and leaves global reservation aligned', () => {
    const userId = 'synthetic-user', day = new Date().toISOString().slice(0, 10);
    assert.equal(service.reserveTestDailyQuota(userId, 20), true);
    assert.equal(service.reserveTestDailyQuota(userId, 1), false);
    assert.equal(database.getTestUsage(userId, day), 20); assert.equal(database.getGlobalTestUsage(day), 20);
  });
  test('invalid runtime change cannot fall back after valid startup', () => {
    process.env.TEST_DAILY_EXTRACTION_LIMIT = 'abc';
    assert.throws(() => service.reserveTestDailyQuota('synthetic-other', 1), /TEST_DAILY_EXTRACTION_LIMIT/);
    assert.equal(database.getGlobalTestUsage(new Date().toISOString().slice(0, 10)), 20);
  });
  test('non-test informational behavior preserved', () => {
    process.env.TEST_MODE = 'false';
    for (const [raw, expected] of [['', 50], ['abc', 50], ['1.5', 1], ['20', 20]]) {
      process.env.TEST_DAILY_EXTRACTION_LIMIT = raw;
      assert.equal(config.getTestDailyLimit(), null); assert.equal(service.getTestDailyLimit(), expected);
    }
  });
  test('shared parser preserves strict global cap behavior', () => {
    for (const raw of [undefined, '', '0', '-1', 'abc', '1.5', '50abc']) {
      assert.throws(() => config.getTestGlobalDailyLimit({ TEST_MODE: 'true', TEST_GLOBAL_DAILY_EXTRACTION_LIMIT: raw }), /TEST_GLOBAL_DAILY_EXTRACTION_LIMIT/);
    }
    assert.equal(config.getTestGlobalDailyLimit({ TEST_MODE: 'true', TEST_GLOBAL_DAILY_EXTRACTION_LIMIT: '20' }), 20);
  });
  console.log(`PASS: ${pass}\nFAIL: ${fail}\nSKIPPED: 0`);
} finally {
  database.db.close();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('beta-quota-config-')) throw new Error('Unsafe cleanup');
  fs.rmSync(directory, { recursive: true, force: true });
}
process.exitCode = fail ? 1 : 0;
