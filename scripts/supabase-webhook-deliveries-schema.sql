-- ═══════════════════════════════════════════════════════════════════════
-- Valmont-Pay — Webhook Deliveries table migration
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.webhook_deliveries (
  id               uuid primary key default gen_random_uuid(),
  tenant_key       text not null,
  reference        text not null,
  event            text not null,
  url              text not null,
  request_body     text,
  response_status  integer,
  response_time_ms integer,
  retry_count      integer not null default 0,
  success          boolean not null default false,
  error            text,
  created_at       timestamptz not null default now()
);

-- Indexes for performance
create index if not exists idx_webhook_deliveries_tenant_key on public.webhook_deliveries(tenant_key);
create index if not exists idx_webhook_deliveries_reference on public.webhook_deliveries(reference);
create index if not exists idx_webhook_deliveries_created_at on public.webhook_deliveries(created_at desc);

-- RLS: service-role only
alter table public.webhook_deliveries enable row level security;

drop policy if exists "webhook_deliveries service-role only" on public.webhook_deliveries;
create policy "webhook_deliveries service-role only" on public.webhook_deliveries
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- Optional: grant read access to anon for the status page IF it uses anon key
-- For now we stick to service-role as per instructions "Per-tenant HMAC only, never Paystack key"
-- though this table doesn't hold Paystack keys.
