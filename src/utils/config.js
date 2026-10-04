const path = require('path');

function parseTestMode(raw) {
  if (raw === undefined || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error('Invalid TEST_MODE: expected lowercase true or false.');
}

function getMaxPagesPerFile(raw = process.env.MAX_PAGES_PER_FILE) {
  // Beta default: below the documented 50-page daily quota.
  if (raw === undefined) return 20;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error('Invalid MAX_PAGES_PER_FILE: expected a positive integer.');
  }
  return Number(raw);
}

function getTestGlobalDailyLimit(env = process.env) {
  if (!parseTestMode(env.TEST_MODE)) return null;
  const raw = env.TEST_GLOBAL_DAILY_EXTRACTION_LIMIT;
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error('Invalid TEST_GLOBAL_DAILY_EXTRACTION_LIMIT: TEST_MODE requires an explicit positive integer.');
  }
  return Number(raw);
}

function startupSummary(env, dailyLimit, uploadLimits) {
  const configured = (value) => !!value && !/x{4,}|replace-with/i.test(value);
  return {
    NODE_ENV: ['production', 'development', 'test'].includes(env.NODE_ENV) ? env.NODE_ENV : 'unset/other',
    TEST_MODE: parseTestMode(env.TEST_MODE) ? 'enabled' : 'disabled',
    TEST_DAILY_EXTRACTION_LIMIT: dailyLimit,
    MAX_FILE_SIZE_MB: uploadLimits.MAX_FILE_SIZE_MB,
    MAX_FILES_PER_REQUEST: uploadLimits.MAX_FILES_PER_REQUEST,
    MAX_PAGES_PER_FILE: getMaxPagesPerFile(env.MAX_PAGES_PER_FILE),
    SQLITE_DB_PATH: path.resolve(env.TEST_DB_PATH || path.join(__dirname, '..', '..', 'data', 'invoice-extractor.sqlite')),
    ANTHROPIC_CONFIGURED: configured(env.ANTHROPIC_API_KEY) ? 'YES' : 'NO',
    RESEND_CONFIGURED: configured(env.RESEND_API_KEY) ? 'YES' : 'NO',
    LAUNCH_MODE: env.LAUNCH_MODE === 'live' ? 'live' : 'waitlist',
  };
}

module.exports = { parseTestMode, getMaxPagesPerFile, getTestGlobalDailyLimit, startupSummary };
