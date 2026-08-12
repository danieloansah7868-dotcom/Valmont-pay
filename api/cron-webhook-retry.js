/**
 * Vercel Cron + manual admin retry for tenant webhook fan-out.
 * Auth: Authorization: Bearer $CRON_SECRET  OR  admin session / X-Admin-Key.
 */

import adminAuthModule from '../lib/admin-auth.js';
import adminSession from '../lib/admin-session.js';
import tenants from '../lib/tenants.js';
import forwarder from '../lib/tenant-webhook-forwarder.js';

const { isAuthorizedAdmin, unauthorizedPayload } = adminAuthModule;
const { isCronAuthorized } = adminSession;
const { retryFailedDeliveries } = forwarder;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ status: false, message: 'Method not allowed' });
  }
  if (!isCronAuthorized(req) && !isAuthorizedAdmin(req)) {
    return res.status(401).json(unauthorizedPayload());
  }
  try {
    const result = await retryFailedDeliveries({ tenants });
    return res.status(200).json({ status: true, ...result });
  } catch (error) {
    return res.status(500).json({ status: false, message: error && error.message ? error.message : String(error) });
  }
}
