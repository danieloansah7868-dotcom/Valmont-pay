-- ═══════════════════════════════════════════════════════════════════════
-- VALMONT-PAY — durable payment links
-- ═══════════════════════════════════════════════════════════════════════
--
-- Run this ONCE in your Supabase project (SQL Editor → New query → Run).
--
-- Why: the dashboard's "Generate link" flow stores payment details behind a
-- one-time access_code. Keeping that data only in server memory means every
-- link dies on a serverless cold start (Vercel) or server restart — the
-- customer sees "Payment Link Invalid". This table makes payment links
-- durable: they survive cold starts, instance changes and restarts, and can
-- live long enough (default 30 days) to be sent to a client by WhatsApp or
-- email.
--
-- Row-level security is enabled with NO policies: anonymous and authenticated
-- clients cannot read or write the table at all. Only the service-role key
-- (SUPABASE_SERVICE_ROLE_KEY), used by the gateway server, bypasses RLS.
-- Access codes are high-entropy (96 bits) and resolve ONLY to the single
-- payment intent they were created for — they are bearer secrets for paying,
-- never for reading ledger data.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.payment_links (
  -- The secret in pay.html?access_code=… (pk). e.g. ac_1a2b3c4d…
  access_code               text        primary key,

  -- Gateway/payment reference, shared with Paystack + the ledger.
  reference                 text        not null,

  -- Amount in MAJOR units (cedis), never pesewas — same contract as the
  -- transactions table.
  amount                    numeric(12,2) not null check (amount > 0),
  currency                  text        not null default 'GHS',

  -- Customer context captured at link-creation time.
  email                     text,
  phone                     text,
  callback_url              text,

  -- Merchant / tenant branding + routing.
  tenant_key                text,
  merchant_display_name     text,
  merchant_brand_color      text,
  merchant_logo_url         text,

  -- Pre-initialized Paystack session (tenant API flow). The gateway may
  -- re-initialize at pay time; these fields are a fast path, not required.
  paystack_authorization_url text,
  paystack_access_code      text,

  -- PENDING at creation. Reserved for future PAID/EXPIRED lifecycle.
  status                    text        not null default 'PENDING',

  created_at                timestamptz not null default now(),
  -- Dashboard links: now + PAYMENT_LINK_TTL_HOURS (default 30 days).
  -- Tenant API checkout sessions: now + 30 minutes (documented contract).
  expires_at                timestamptz
);

comment on table public.payment_links is
  'Durable backing for pay.html?access_code=… payment links. Written/read by the Valmont-Pay gateway server (service role only).';

-- Lookups by reference (reconciliation) and the expiry sweeps.
create index if not exists payment_links_reference_idx
  on public.payment_links (reference);
create index if not exists payment_links_expires_at_idx
  on public.payment_links (expires_at);

-- Deny-by-default for everyone except the service role.
alter table public.payment_links enable row level security;

-- Optional hygiene: purge rows that expired long ago (keep 7 days of tail
-- for debugging). Safe to run manually or as a scheduled job.
--   delete from public.payment_links
--   where expires_at is not null
--     and expires_at < now() - interval '7 days';
