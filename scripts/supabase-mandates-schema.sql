-- ═══════════════════════════════════════════════════════════════════════
-- VALMONT-PAY — recurring payment mandates & standing instructions
-- ═══════════════════════════════════════════════════════════════════════
--
-- Run this ONCE in your Supabase project (SQL Editor → New query → Run).
--
-- Why: When a merchant initiates a recurring payment or standing instruction
-- (e.g. MTN MoMo auto-renewal or recurring card billing), Paystack issues a
-- reusable authorization_code after the initial customer-authorized debit.
-- This table durably stores active mandates so tenants and merchants can
-- inspect, revoke, or execute subsequent merchant-initiated debits via
-- Paystack's /transaction/charge_authorization endpoint.
--
-- Consumer protection compliance: Mandates can be revoked at any time
-- by updating status to 'REVOKED' (Act 987 & BoG consumer rules).
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.mandates (
  -- Paystack reusable authorization code (e.g. AUTH_xxxxxxxxx) (pk).
  authorization_code        text        primary key,

  -- Initial gateway/payment reference where the mandate was granted.
  reference                 text        not null,

  -- Customer email address associated with the mandate.
  customer_email            text        not null,

  -- Merchant name or tenant key.
  merchant_name             text        not null default 'Valmont-Pay',
  tenant_key                text,

  -- Payment channel and operator (e.g. 'Momo (MTN)', 'Credit/Debit Card', bank='MTN').
  payment_method            text        not null default 'Unknown',
  bank                      text,

  -- Optional recurring amount in MAJOR units (GH₵).
  amount                    numeric(12,2),
  currency                  text        not null default 'GHS',

  -- ACTIVE / REVOKED / EXPIRED. Only ACTIVE mandates can be charged.
  status                    text        not null default 'ACTIVE',

  -- Custom metadata associated with the mandate or initial transaction.
  metadata                  jsonb       default '{}'::jsonb,

  -- Timestamp when the mandate was last charged via charge_authorization.
  last_charged_at           timestamptz,

  created_at                timestamptz not null default now()
);

comment on table public.mandates is
  'Durable backing for customer standing mandates and recurring authorization codes. Written/read by the Valmont-Pay gateway server (service role only).';

-- Lookups by merchant, email, and status for filtering and admin queries.
create index if not exists mandates_merchant_name_idx
  on public.mandates (merchant_name);
create index if not exists mandates_customer_email_idx
  on public.mandates (customer_email);
create index if not exists mandates_status_idx
  on public.mandates (status);

-- RLS: service-role only.
--
-- This table stores reusable Paystack authorization_codes — tokens that can
-- pull money from a customer's card or MoMo wallet. It is the single most
-- sensitive table in the schema and must never be readable with the anon key.
--
-- Enabling RLS with NO policy is already deny-all, so this was correct by
-- accident. The explicit policy below makes the intent reviewable and matches
-- the pattern used by tenants / webhook_deliveries.
alter table public.mandates enable row level security;

drop policy if exists "mandates service-role only" on public.mandates;
create policy "mandates service-role only" on public.mandates
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
