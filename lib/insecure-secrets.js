/**
 * Well-known development secrets that must NEVER authenticate in production.
 * They exist so `npm start` works out of the box; they are also in git.
 */

const INSECURE_SECRETS = new Set([
  'vme_secret_dev_key_1',
  'vmw_secret_dev_key_1',
  'vme_pub_dev_key_1',
  'vmw_pub_dev_key_1',
  'vme_webhook_signing_dev_1',
  'vmw_webhook_signing_dev_1'
]);

function isProductionRuntime() {
  if (process.env.VALMONT_STRICT_SECRETS === '1') return true;
  if (process.env.VALMONT_STRICT_SECRETS === '0') return false;
  return process.env.VERCEL_ENV === 'production'
    || process.env.NODE_ENV === 'production';
}

function isInsecureSecret(value) {
  if (!value) return false;
  return INSECURE_SECRETS.has(String(value).trim());
}

function rejectInsecureSecret(value) {
  return isProductionRuntime() && isInsecureSecret(value);
}

module.exports = {
  INSECURE_SECRETS,
  isProductionRuntime,
  isInsecureSecret,
  rejectInsecureSecret
};
