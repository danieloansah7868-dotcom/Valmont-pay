-- Receive Links — Pay Me directly to MoMo / Bank / Subaccount
-- Run in Supabase SQL Editor. Safe to re-run.
create table if not exists receive_links (
  code text primary key,
  receiver_email text not null,
  receiver_name text not null,
  destination_type text not null check (destination_type in ('momo','bank','subaccount')),
  destination text not null, -- phone or bank string or ACCT_...
  amount numeric(12,2), -- null = payer chooses
  currency text not null default 'GHS',
  note text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists idx_receive_links_email on receive_links(receiver_email);
alter table receive_links enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where policyname='service_role_all_receive') then
    create policy service_role_all_receive on receive_links for all using (true) with check (true);
  end if;
end $$;
