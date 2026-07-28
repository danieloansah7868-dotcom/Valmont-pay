/**
 * Print a fresh Valmont-Pay keypair set, ready to paste into .env / Vercel.
 *   npm run keys
 */
import { createRequire } from 'node:module';
const keys = createRequire(import.meta.url)('../lib/keys.js');
const set = keys.generateKeySet();

console.log('\n# Valmont-Pay API keys — store the sk_* values as secrets.');
console.log('# pk_* keys are browser-safe. sk_* keys are SERVER ONLY.\n');
for (const mode of ['test', 'live']) {
  console.log(`VALMONTPAY_${mode.toUpperCase()}_PUBLIC_KEY=${set[mode].public_key}`);
  console.log(`VALMONTPAY_${mode.toUpperCase()}_SECRET_KEY=${set[mode].secret_key}`);
}
console.log('');
