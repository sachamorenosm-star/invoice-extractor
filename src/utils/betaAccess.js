const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_PATTERN.test(email.trim());
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function getBetaAllowedEmails() {
  return new Set((process.env.BETA_ALLOWED_EMAILS || '').split(',')
    .map((email) => email.trim()).filter(isValidEmail).map(normalizeEmail));
}

function isBetaAllowedEmail(email) {
  return isValidEmail(email) && (process.env.TEST_MODE !== 'true' || getBetaAllowedEmails().has(normalizeEmail(email)));
}

module.exports = { isValidEmail, normalizeEmail, getBetaAllowedEmails, isBetaAllowedEmail };
