/**
 * /api/webhook-status — JSON backing the /webhook-status.html diagnostic page.
 *
 * Reports:
 *   - the webhook configuration this deployment is actually running with
 *   - environment variable STATUS (never values — booleans, lengths, hashes)
 *   - the common-misconfiguration checklist, each item as pass / warn / fail
 *   - inbound webhook requests this instance has observed
 *   - the last 10 Paystack transactions, flagged as saved or missing locally
 *
 * Add ?paystack=0 to skip the outbound Paystack API call.
 */

import diagnostics from '../lib/webhook-diagnostics.js';
import adminAuthModule from '../lib/admin-auth.js';

const { buildDiagnostics } = diagnostics;
const { isAuthorizedAdmin, unauthorizedPayload } = adminAuthModule;

export default async function handler(req, res) {
  if (!isAuthorizedAdmin(req)) {
    return res.status(401).json(unauthorizedPayload());
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const url = new URL(req.url || '/api/webhook-status', 'http://localhost');
  const includePaystack = url.searchParams.get('paystack') !== '0';

  try {
    const payload = await buildDiagnostics(req, { includePaystack });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(payload);
  } catch (error) {
    console.error('[WEBHOOK-STATUS] Failed to build diagnostics:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to build webhook diagnostics',
      message: error && error.message ? error.message : String(error)
    });
  }
}
