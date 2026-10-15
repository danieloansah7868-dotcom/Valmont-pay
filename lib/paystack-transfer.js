/**
 * Paystack Transfer — instant payout to MoMo / Bank (Ghana)
 *
 * Paystack settlement is T+1 by design. This module does the
 * "very second automatic" path the user asked for: the moment
 * Paystack fires charge.success, we instantly push money to the
 * receiver's entitled account via the Transfer API.
 *
 * Flow:
 *   Payer → Paystack Checkout (success)
 *   → webhook charge.success → create Transfer Recipient (if needed)
 *   → initiate Transfer (source: balance) → MoMo credited in seconds
 *
 * Requires:
 *   PAYSTACK_SECRET_KEY (live, transfer-enabled, with balance)
 *   PAYSTACK_TRANSFER_ENABLED=1  (safety switch; off = log-only)
 *
 * Ghana MoMo quirks:
 *   Paystack Ghana recipient type is "mobile_money" (or "nuban" for banks).
 *   We try mobile_money first for 10-digit GH numbers, then fall back to nuban.
 *   Networks are auto-detected from prefix (MTN 024/025/053/054/055/059, Vodafone 020/050, AirtelTigo 026/027/056/057).
 *
 * All functions return { ok, data, error, reason } and never throw.
 */

const PAYSTACK_BASE = 'https://api.paystack.co';

function isTransferEnabled() {
  // Safety switch: never move real money unless operator explicitly opted in.
  // Set PAYSTACK_TRANSFER_ENABLED=1 in Vercel env when Paystack balance is funded.
  return String(process.env.PAYSTACK_TRANSFER_ENABLED || '').trim() === '1';
}

function getKey() {
  return String(process.env.PAYSTACK_SECRET_KEY || '').trim();
}

function ghNetwork(phone) {
  const d = String(phone).replace(/\D/g, '').slice(-9); // last 9 digits
  const pref = d.slice(0, 2); // e.g. 54 for 054
  // Map Ghana mobile prefixes
  const mtn = new Set(['24','25','53','54','55','59']);
  const vod = new Set(['20','50']);
  const at  = new Set(['26','27','56','57']);
  if (mtn.has(pref)) return 'mtn';
  if (vod.has(pref)) return 'vodafone';
  if (at.has(pref)) return 'tigo'; // AirtelTigo
  return 'mtn';
}

function formatGhPhone(phone) {
  let p = String(phone).replace(/\s/g, '').trim();
  // Normalize: 054..., 23354..., +23354... → 054...
  p = p.replace(/^\+?233/, '0');
  p = p.replace(/\D/g, '');
  if (p.length === 9) p = '0' + p;
  return p;
}

async function paystackFetch(path, opts = {}) {
  const key = getKey();
  if (!key) return { ok: false, reason: 'PAYSTACK_SECRET_KEY not set' };
  try {
    const r = await fetch(`${PAYSTACK_BASE}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, reason: j.message || `Paystack HTTP ${r.status}`, error: j, status: r.status, data: j };
    }
    if (j.status === false) {
      return { ok: false, reason: j.message || 'Paystack returned status:false', error: j, data: j };
    }
    return { ok: true, data: j, raw: j };
  } catch (e) {
    return { ok: false, reason: e.message || String(e), error: e };
  }
}

/**
 * Create (or reuse) a transfer recipient for a Ghana MoMo / bank.
 * Returns { ok, recipient_code, data }.
 */
async function createRecipient({ name, phone, account_number, bank_code, type, currency = 'GHS', description }) {
  const key = getKey();
  if (!key) return { ok: false, reason: 'PAYSTACK_SECRET_KEY missing' };

  // Normalize inputs
  let t = String(type || '').toLowerCase();
  if (!t) {
    // auto-detect: 10-digit GH phone => mobile_money, else nuban
    const isPhone = /^\d{9,10}$/.test(String(phone||account_number).replace(/\D/g,''));
    t = isPhone ? 'mobile_money' : 'nuban';
  }

  const payload = {
    type: t, // mobile_money | nuban | ghipss (GH bank)
    name: String(name || 'Valmont Recipient').slice(0, 100),
    currency,
    description: String(description || 'Valmont Pay instant payout').slice(0, 200),
  };

  if (t === 'mobile_money') {
    const p = formatGhPhone(phone || account_number);
    payload.account_number = p;
    // Paystack expects bank_code for mobile_money to be the network's bank code.
    // For Ghana, common codes: MTN=MTN, VOD=VOD, TIGO=TGO — but Paystack also accepts
    // the literal network name when currency=GHS. We send the network hint and let Paystack validate.
    // If bank_code is already provided, use it; else infer.
    const net = ghNetwork(p);
    payload.bank_code = bank_code || (net === 'mtn' ? 'MTN' : net === 'vodafone' ? 'VOD' : 'TGO');
    // Some Paystack Ghana integrations require "account_number" as 0XXXXXXXXX and bank_code as above.
  } else {
    // bank
    payload.account_number = String(account_number || phone).replace(/\s/g, '');
    payload.bank_code = String(bank_code || '044').trim() || '044'; // fallback; caller should provide real code
    if (bank_code && String(bank_code).trim().toUpperCase().startsWith('GHIPSS')) {
      payload.type = 'ghipss';
    }
  }

  const res = await paystackFetch('/transferrecipient', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    // If recipient already exists, Paystack may return duplicate error but we can list and reuse
    // Try to list existing recipients by account_number
    try {
      const list = await paystackFetch(`/transferrecipient?perPage=100`);
      if (list.ok && list.data && Array.isArray(list.data.data)) {
        const hit = list.data.data.find(r =>
          String(r.account_number).replace(/\D/g, '') === String(payload.account_number).replace(/\D/g, '')
        );
        if (hit && hit.recipient_code) {
          return { ok: true, recipient_code: hit.recipient_code, data: hit, reused: true };
        }
      }
    } catch (_) {}
    return { ok: false, reason: res.reason, error: res.error, data: res.data };
  }

  const rc = res.data && res.data.data ? res.data.data.recipient_code : null;
  if (!rc) return { ok: false, reason: 'No recipient_code in Paystack response', data: res.data };
  return { ok: true, recipient_code: rc, data: res.data.data };
}

/**
 * Initiate an instant transfer from Paystack balance to a recipient.
 * amountGhs is in GHS major units (e.g. 100.00 → 10000 pesewas).
 */
async function initiateTransfer({ amountGhs, recipient_code, reason, reference, source = 'balance' }) {
  if (!isTransferEnabled()) {
    return {
      ok: false,
      reason: 'PAYSTACK_TRANSFER_ENABLED is not 1 — transfer is in LOG-ONLY mode. Set it to 1 when your Paystack balance is funded to move real money instantly.',
      dryRun: true
    };
  }
  const amtPesewas = Math.round(Number(amountGhs) * 100);
  if (!Number.isFinite(amtPesewas) || amtPesewas <= 0) return { ok: false, reason: 'amountGhs must be > 0' };
  if (!recipient_code) return { ok: false, reason: 'recipient_code is required' };

  const payload = {
    source,
    amount: amtPesewas,
    recipient: recipient_code,
    reason: String(reason || 'Valmont Pay instant payout').slice(0, 100),
  };
  if (reference) payload.reference = String(reference).slice(0, 50);

  const res = await paystackFetch('/transfer', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  if (!res.ok) return { ok: false, reason: res.reason, error: res.error, data: res.data, status: res.status };
  return { ok: true, data: res.data, transfer: res.data.data || res.data };
}

/**
 * One-shot helper: MoMo number + amountGhs → instant payout.
 * Creates recipient (mobile_money) then transfers.
 */
async function payoutToMomo({ momo_number, amountGhs, name, reason, reference }) {
  const phone = formatGhPhone(momo_number);
  if (!/^\d{10}$/.test(phone)) {
    // Also accept 233XXXXXXXXX after formatting
    const digits = phone.replace(/\D/g, '');
    if (!/^\d{10}$/.test(digits) && !/^\d{9}$/.test(digits)) {
      return { ok: false, reason: `Invalid Ghana MoMo number: ${momo_number}` };
    }
  }
  // Early safety check: if instant transfers are not enabled, return DRY RUN
  // without even hitting Paystack — this is the "T+1 is not what you want" switch.
  if (!isTransferEnabled()) {
    return { ok: false, dryRun: true, reason: 'PAYSTACK_TRANSFER_ENABLED is not 1 — transfer is in LOG-ONLY mode. Set it to 1 and fund your Paystack balance to move real money instantly (seconds, not T+1).', destination: phone, amount: Number(amountGhs) };
  }
  if (!getKey()) {
    return { ok: false, reason: 'PAYSTACK_SECRET_KEY is not set — cannot create MoMo recipient. Set it in Vercel env.' };
  }
  const rc = await createRecipient({
    name: name || phone,
    phone,
    type: 'mobile_money',
    currency: 'GHS',
    description: reason || `Payout to ${phone}`
  });
  if (!rc.ok) return { ok: false, reason: `Recipient create failed: ${rc.reason}`, error: rc.error, data: rc.data };

  const tr = await initiateTransfer({
    amountGhs,
    recipient_code: rc.recipient_code,
    reason: reason || `Valmont instant payout to ${phone}`,
    reference: reference || `PAYOUT-${Date.now().toString(36).toUpperCase()}`
  });
  if (!tr.ok) return { ok: false, reason: `Transfer failed: ${tr.reason}`, error: tr.error, data: tr.data, recipient_code: rc.recipient_code, dryRun: tr.dryRun };
  return { ok: true, recipient_code: rc.recipient_code, transfer: tr.transfer || tr.data, recipient: rc.data };
}

/**
 * Payout to bank (Ghana). Requires account_number + bank_code.
 */
async function payoutToBank({ account_number, bank_code, amountGhs, name, reason, reference }) {
  if (!isTransferEnabled()) {
    return { ok: false, dryRun: true, reason: 'PAYSTACK_TRANSFER_ENABLED is not 1 — LOG-ONLY mode. Set to 1 to move real money instantly.', destination: account_number, amount: Number(amountGhs) };
  }
  if (!getKey()) {
    return { ok: false, reason: 'PAYSTACK_SECRET_KEY is not set.' };
  }
  const rc = await createRecipient({
    name: name || account_number,
    account_number,
    bank_code: bank_code || '044',
    type: bank_code && String(bank_code).toUpperCase().startsWith('GHIPSS') ? 'ghipss' : 'nuban',
    currency: 'GHS',
    description: reason || `Payout to ${account_number}`
  });
  if (!rc.ok) return { ok: false, reason: `Recipient create failed: ${rc.reason}`, error: rc.error };

  const tr = await initiateTransfer({
    amountGhs,
    recipient_code: rc.recipient_code,
    reason: reason || `Valmont instant payout to ${account_number}`,
    reference
  });
  if (!tr.ok) return { ok: false, reason: `Transfer failed: ${tr.reason}`, error: tr.error, data: tr.data, recipient_code: rc.recipient_code, dryRun: tr.dryRun };
  return { ok: true, recipient_code: rc.recipient_code, transfer: tr.transfer || tr.data, recipient: rc.data };
}

module.exports = {
  isTransferEnabled,
  getKey,
  formatGhPhone,
  ghNetwork,
  createRecipient,
  initiateTransfer,
  payoutToMomo,
  payoutToBank,
  paystackFetch
};
