// Preload for offline regression gates, including their child processes.
// Set empty strings in Node (PowerShell removes empty environment values)
// so dotenv cannot load local provider credentials.
for (const key of ['ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) {
  process.env[key] = '';
}
const net = require('net');
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = net._normalizeArgs(args);
  const options = normalized[0];
  const host = options.host || 'localhost';
  if (options.path || !['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('Offline regression gate blocked non-loopback connection');
  }
  return originalConnect.apply(this, args);
};
