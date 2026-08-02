-- ═══════════════════════════════════════════════════════════════════════
-- Valmont-Pay — Tenants table migration
-- Run this in the Supabase SQL editor once per project.
--
-- Effective tenant configuration uses one explicit precedence everywhere:
--   non-empty TENANT__... env var > non-null DB value > in-code default.
-- The database remains the admin-editable source; deployment env vars are
-- intentional operator overrides, while defaults make a clean deploy usable.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.tenants (
  id               uuid primary key default gen_random_uuid(),
  key              text unique not null check (key ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name     text not null,
  brand_color      text not null default '#f68b1e',
  logo_url         text not null default '/logo.svg',
  currency         text not null default 'GHS',
  -- Display/admin metadata only. This value NEVER selects Paystack credentials;
  -- payment mode is determined by the actual configured sk_test_/sk_live_ key.
  environment      text not null default 'test' check (environment in ('test','live')),
  webhook_url      text,
  paystack_subaccount text,       -- optional ACCT_xxx code for Paystack split payout
  settlement_account text,
  allowed_domains  text[] not null default array[]::text[],
  secret_key_1     text not null,
  secret_key_2     text,
  public_key       text,
  paystack_secret_key text,       -- tenant's own Paystack sk (subaccount billing)
  paystack_public_key text,
  webhook_signing_secret text not null default encode(gen_random_bytes(32), 'hex'),  -- HMAC secret for x-valmontpay-signature
  status           text not null default 'active' check (status in ('active','disabled')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Automatic updated_at trigger
create or replace function public.touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_tenants_touch on public.tenants;
create trigger trg_tenants_touch
before update on public.tenants
for each row execute function public.touch_updated_at();

-- Indexes
create index if not exists idx_tenants_status on public.tenants(status);

-- RLS: service-role only (admin writes). The anon key should NOT be able to
-- read/write tenant secrets. The server holds SUPABASE_SERVICE_ROLE_KEY and
-- is the only writer.
alter table public.tenants enable row level security;

drop policy if exists "tenants service-role only" on public.tenants;
create policy "tenants service-role only" on public.tenants
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- Seed both built-in tenants. The Electricals receiver is operational by
-- default; Valmont Web has no receiver contract yet, so its URL remains NULL.
--
-- On re-run, an existing non-null webhook_url wins so prior admin edits are
-- preserved. The built-in environment labels are intentionally corrected to
-- LIVE below; environment is display-only and does not route Paystack traffic.
insert into public.tenants as existing (
  key, display_name, brand_color, currency, environment,
  webhook_url, paystack_subaccount, settlement_account,
  allowed_domains,
  secret_key_1, public_key, status
) values
(
  'valmont-electricals',
  'Valmont Electricals',
  '#f68b1e',
  'GHS',
  'live',
  'https://valmontelectricals.com/api/valmontpay/webhook',
  null,
  'GCB Bank - 1234567890',
  array['valmontelectricals.com','valmontweb.com','valmontpay.app','localhost'],
  'vme_secret_dev_key_1',
  'vme_pub_dev_key_1',
  'active'
),
(
  'valmontweb',
  'Valmont Web',
  '#2563eb',
  'GHS',
  'live',
  null,
  null,
  'GCB Bank - 0987654321',
  array['valmontweb.com','valmontpay.app','localhost'],
  'vmw_secret_dev_key_1',
  'vmw_pub_dev_key_1',
  'active'
)
on conflict (key) do update set
  webhook_url = coalesce(existing.webhook_url, excluded.webhook_url);

-- Correct rows created by the original seed, which labelled production
-- built-ins as TEST. This is safe because the label is not a payment-mode gate.
update public.tenants
set environment = 'live'
where key in ('valmont-electricals', 'valmontweb')
  and environment is distinct from 'live';
NOTIFY pgrst, 'reload schema';
