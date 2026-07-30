/**
 * Vercel serverless function — /api/test-webhook
 *
 * The dumbest possible POST receiver. No signature check, no database, no
 * validation: it exists purely to prove that an HTTP POST from the outside
 * world can reach this deployment at all.
 *
 * When Paystack "isn't delivering", this endpoint answers the first question in
 * the debugging chain — is the deployment reachable, or is the real webhook
 * rejecting something? Send it a payload and watch the logs:
 *
 *   curl -i -X POST https://valmont-pay.vercel.app/api/test-webhook \
 *     -H 'Content-Type: application/json' \
 *     -d '{"event":"charge.success","data":{"reference":"VP-TEST"}}'
 *
 * It mirrors the Express route of the same name in server.js so either wiring
 * (vercel.json routes this path to the function; server.js serves it locally)
 * behaves identically.
 *
 * This endpoint must NEVER be the thing that fails: a POST always returns 200,
 * even when the body is malformed or empty.
 */

import webhookLog from '../lib/webhook-log.js';

const { recordWebhookHit } = webhookLog;

// Read the exact bytes ourselves, the same way api/webhook.js does, so the
// reported body size is what the caller actually sent.
export const config = {
  api: {
    bodyParser: false
  }
};

/** Collect the raw request body, whatever form the runtime handed it to us in. */
async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody, 'utf8');
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  if (req.body && typeof req.body === 'object') {
    return Buffer.from(JSON.stringify(req.body), 'utf8');
  }
  if (typeof req[Symbol.asyncIterator] !== 'function') return Buffer.alloc(0);

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  const receivedAt = new Date().toISOString();
  const headers = req.headers || {};

  console.log('========================================');
  console.log(`[TEST-WEBHOOK] ${req.method} request received at ${receivedAt}`);
  console.log('[TEST-WEBHOOK] URL:', req.url || '/api/test-webhook');
  console.log('[TEST-WEBHOOK] Headers:', JSON.stringify(headers, null, 2));

  if (req.method === 'GET' || req.method === 'HEAD') {
    console.log('[TEST-WEBHOOK] GET probe — endpoint is reachable');
    console.log('========================================');
    return res.status(200).json({
      success: true,
      message: 'Test webhook endpoint is alive. POST here to log a request body.',
      method: req.method,
      receivedAt
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    console.log('[TEST-WEBHOOK] Rejected method:', req.method);
    console.log('========================================');
    return res.status(405).json({
      success: false,
      error: 'Method not allowed',
      method: req.method
    });
  }

  const rawBuffer = await readRawBody(req);
  const rawBody = rawBuffer.toString('utf8');
  const bodyBytes = rawBuffer.length;

  // A malformed body is INFORMATION, not an error: report the parse failure and
  // still return 200 so the caller learns the request arrived intact.
  let parsedBody = null;
  let bodyParseError = null;
  if (rawBody.trim()) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch (error) {
      bodyParseError = error && error.message ? error.message : String(error);
    }
  }

  const signaturePresent = Boolean(headers['x-paystack-signature']);

  console.log('[TEST-WEBHOOK] Body bytes:', bodyBytes);
  console.log('[TEST-WEBHOOK] Raw body:', rawBody || '(empty)');
  console.log('[TEST-WEBHOOK] Parsed body:', JSON.stringify(parsedBody, null, 2));
  if (bodyParseError) console.log('[TEST-WEBHOOK] Body parse error:', bodyParseError);
  console.log('[TEST-WEBHOOK] x-paystack-signature present:', signaturePresent);
  console.log('========================================');

  // Record the hit so /api/webhook-status can prove this instance received it.
  recordWebhookHit({
    endpoint: '/api/test-webhook',
    method: req.method,
    headers,
    body: rawBody,
    event: parsedBody && parsedBody.event ? String(parsedBody.event) : null,
    reference:
      parsedBody && parsedBody.data && parsedBody.data.reference
        ? String(parsedBody.data.reference)
        : null,
    outcome: 'test-endpoint-ok',
    statusCode: 200
  });

  // ALWAYS 200.
  const payload = {
    success: true,
    received: true,
    message: 'Test webhook received. Check the server logs for the full dump.',
    receivedAt,
    method: req.method,
    signaturePresent,
    bodyBytes,
    body: parsedBody,
    headers
  };
  if (bodyParseError) payload.bodyParseError = bodyParseError;

  return res.status(200).json(payload);
}
