-- Valmont Pay — Virtual Cards (MoMo-direct)
-- Run this in Supabase SQL Editor. Safe to re-run (IF NOT EXISTS).

-- Wallets: one row per customer_email, holds GHS balance that can fund any card
create table if not exists virtual_wallets (
  customer_email text primary key,
  balance_ghs numeric(12,2) not null default 0,
  balance_usd numeric(12,2) not null default 0,
  updated_at timestamptz not null default now()
);

-- Cards
create table if not exists virtual_cards (
  id text primary key,
  customer_email text not null,
  holder_name text not null,
  pan_masked text not null,
  last4 text not null,
  expiry text not null,
  currency text not null default 'USD' check (currency in ('GHS','USD')),
  balance_ghs numeric(12,2) not null default 0,
  balance_usd numeric(12,2) not null default 0,
  status text not null default 'active' check (status in ('active','frozen','terminated')),
  spending_limit_usd numeric(12,2),
  tenant_key text,
  provider text not null default 'internal' check (provider in ('internal','strowallet','maplerad','flutterwave')),
  provider_card_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_virtual_cards_customer on virtual_cards(customer_email);
create index if not exists idx_virtual_cards_status on virtual_cards(status);

-- Card transactions (funding + purchases)
create table if not exists virtual_card_transactions (
  id text primary key,
  card_id text not null references virtual_cards(id) on delete cascade,
  type text not null check (type in ('funding','purchase','refund','fee')),
  amount_ghs numeric(12,2),
  amount_usd numeric(12,2),
  fx_rate numeric(12,4),
  momo_number text,
  merchant text,
  reference text,
  status text not null default 'success',
  created_at timestamptz not null default now()
);
create index if not exists idx_vctx_card on virtual_card_transactions(card_id, created_at desc);

-- RLS: allow service_role full access, anon none (gateway uses service_role key)
alter table virtual_wallets enable row level security;
alter table virtual_cards enable row level security;
alter table virtual_card_transactions enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'service_role_all_wallets') then
    create policy service_role_all_wallets on virtual_wallets for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'service_role_all_cards') then
    create policy service_role_all_cards on virtual_cards for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'service_role_all_vctx') then
    create policy service_role_all_vctx on virtual_card_transactions for all using (true) with check (true);
  end if;
end $$;
