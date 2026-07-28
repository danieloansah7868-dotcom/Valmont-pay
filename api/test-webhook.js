/**
 * /api/test-webhook — the dumbest possible POST receiver.
 *
 * Its ONLY job is to answer one question: can an HTTP POST from the outside
 * world reach this deployment at all?
 *
 * It deliberately does NOT verify signatures, does NOT touch Supabase and does
 * NOT validate the payload, so absolutely nothing can make it fail. If a POST
 * here returns 200 but /api/webhook never records anything, the problem is in
 * Paystack's configuration (wrong URL / wrong mode), not in the network path.
 *
 * Try it:
 *   curl -i -X POST https://valmont-pay.vercel.app/api/test-webhook \
 *     -H 'Content-Type: application/json' \
 *     -d '{"event":"charge.success","data":{"reference":"TEST-1"}}'
 */

import webhookLog from '../lib/webhook-log.js';

const { recordWebhookHit } = webhookLog;

// Read the exact bytes ourselves, exactly like the real webhook does, so this
// endpoint also proves whether the raw body arrives intact.
export const config = {
  api: {
    bodyParser: false
  }
};

/** Read the raw request body, tolerating pre-parsed bodies from Express/tests. */
async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);

  if (typeof req[Symbol.asyncIterator] !== 'function') return '';

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  const receivedAt = new Date().toISOString();

  console.log('========================================');
  console.log(`[TEST-WEBHOOK] ${req.method} request received at ${receivedAt}`);
  console.log('[TEST-WEBHOOK] URL:', req.url || '(unknown)');
  console.log('[TEST-WEBHOOK] Headers:', JSON.stringify(req.headers || {}, null, 2));

  // A GET is allowed purely so you can confirm the route exists in a browser.
  if (req.method === 'GET') {
    console.log('[TEST-WEBHOOK] GET probe — endpoint is reachable');
    console.log('========================================');
    return res.status(200).json({
      success: true,
      message: 'Test webhook endpoint is alive. POST here to log a request body.',
      method: 'GET',
      receivedAt,
      hint:
        "curl -X POST <origin>/api/test-webhook -H 'Content-Type: application/json' -d '{\"ping\":true}'"
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    console.log('[TEST-WEBHOOK] Rejected method:', req.method);
    console.log('========================================');
    return res.status(405).json({ success: false, error: 'Method not allowed', method: req.method });
  }

  let rawBody = '';
  let readError = null;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    readError = error && error.message ? error.message : String(error);
    console.error('[TEST-WEBHOOK] Failed to read request body:', error);
  }

  console.log('[TEST-WEBHOOK] Body bytes:', Buffer.byteLength(rawBody, 'utf8'));
  console.log('[TEST-WEBHOOK] Raw body:', rawBody || '(empty)');

  let parsedBody = null;
  let parseError = null;
  if (rawBody) {
    try {
      parsedBody = JSON.parse(rawBody);
      console.log('[TEST-WEBHOOK] Parsed JSON body:', JSON.stringify(parsedBody, null, 2));
    } catch (error) {
      parseError = error && error.message ? error.message : String(error);
      console.log('[TEST-WEBHOOK] Body is not JSON:', parseError);
    }
  }

  const signature = (req.headers && req.headers['x-paystack-signature']) || null;
  console.log('[TEST-WEBHOOK] x-paystack-signature present:', Boolean(signature));
  console.log('========================================');

  // Record it so /webhook-status.html can show that a POST really landed.
  recordWebhookHit({
    endpoint: '/api/test-webhook',
    method: req.method,
    headers: req.headers,
    body: rawBody,
    event: parsedBody && parsedBody.event ? String(parsedBody.event) : null,
    reference:
      parsedBody && parsedBody.data && parsedBody.data.reference
        ? String(parsedBody.data.reference)
        : null,
    outcome: 'test-endpoint-ok',
    statusCode: 200,
    detail: { signaturePresent: Boolean(signature), parseError, readError }
  });

  // ALWAYS 200 — this endpoint must never be the thing that fails.
  return res.status(200).json({
    success: true,
    received: true,
    message: 'Test webhook received. Check the runtime logs for the full dump.',
    receivedAt,
    method: req.method,
    signaturePresent: Boolean(signature),
    bodyBytes: Buffer.byteLength(rawBody, 'utf8'),
    body: parsedBody !== null ? parsedBody : rawBody || null,
    bodyParseError: parseError,
    bodyReadError: readError,
    headers: req.headers || {}
  });
}
