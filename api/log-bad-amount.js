/**
 * POST /api/log/bad-amount
 *
 * Best-effort audit endpoint for pay.html's unit-mismatch detector.
 * When pay.html receives a URL whose `amount` parameter looks like
 * pesewas (e.g. `amount=2300` for a GH₵23 cart) the page refuses to
 * render the payment form and posts the offending URL here so we can
 * see which client site is mis-configured.
 *
 * The endpoint:
 *   • NEVER blocks pay.html — it's called via navigator.sendBeacon,
 *     failures are silently dropped by the client.
 *   • NEVER returns 4xx for empty/malformed bodies — we always 200
 *     so a misbehaving client can't crash the user's tab.
 *   • Caps the body size and the URL length to keep log lines bounded
 *     and to avoid abuse.
 *   • Logs to stdout (visible in Vercel runtime logs) with a single
 *     prefixed line per rejection. Future enhancement: a dedicated
 *     bad-amount table in Supabase.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    // Defensive caps. sendBeacon sends at most 64 KB and we expect a
    // few hundred bytes; the cap is purely to keep log lines bounded.
    const rawAmount = typeof body.rawAmount === 'string' ? body.rawAmount.slice(0, 32) : null;
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 64) : null;
    const suspectUnit = typeof body.suspectUnit === 'string' ? body.suspectUnit.slice(0, 16) : null;
    const merchant = typeof body.merchant === 'string' ? body.merchant.slice(0, 64) : null;
    const ref = typeof body.ref === 'string' ? body.ref.slice(0, 64) : null;
    const url = typeof body.url === 'string' ? body.url.slice(0, 512) : null;
    const userAgent = typeof body.userAgent === 'string' ? body.userAgent.slice(0, 256) : null;
    const path = typeof body.path === 'string' ? body.path.slice(0, 64) : null;

    // Only log the unit-mismatch case (the only thing pay.html sends
    // today). Other reasons are accepted but not logged to keep the
    // audit line single-purpose.
    if (reason === 'looks-like-pesewas' && rawAmount) {
      console.warn(
        `[VALMONT-PAY][BAD-AMOUNT] unit=mismatch reason=${reason} ` +
        `rawAmount=${rawAmount} suspectUnit=${suspectUnit || 'pesewas'} ` +
        `merchant=${merchant || 'unknown'} ref=${ref || 'none'} ` +
        `path=${path || 'unknown'} url=${url || 'unknown'} ` +
        `ua=${userAgent || 'unknown'}`
      );
    } else {
      // Acknowledge the call without logging. We still respond 200 so
      // a future client that wants to send a different reason will work.
    }
  } catch (err) {
    // Never let a malformed body prevent the audit endpoint from
    // returning — a misbehaving client must not see a 5xx.
    console.warn('[VALMONT-PAY][BAD-AMOUNT] malformed body (ignored):', err && err.message ? err.message : err);
  }

  // Always 200. This endpoint is best-effort; the customer has
  // already been shown the error screen by the client-side validator.
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({ success: true });
}
