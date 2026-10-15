-- Valmont-Pay — transactions.failure_reason migration
--
-- WHY THIS EXISTS
--
-- When a card payment fails, Paystack tells us exactly why — its `gateway_response`
-- ("Denied by Fraud System", "Declined", "Insufficient Funds", "Unrecognized card
-- type", "Pickup card", ...). We used to record only the status, so the dashboard
-- showed a bare red FAILED badge and every "why did my customer's payment fail?"
-- question turned into guesswork or a Paystack support ticket.
--
-- This column stores that reason verbatim on the transaction row.
--
-- SAFE TO RUN AT ANY TIME
--
-- The application does NOT depend on this column existing. Until you run it:
--   * SUCCESS rows are written exactly as before;
--   * a FAILED row is still written, but without its reason — the writer detects
--     the missing column, drops it and retries, so a payment is never rejected
--     because of a diagnostic field (see lib/transaction-store.js);
--   * the reason is still printed in the runtime logs (Vercel → Logs, search for
--     "gatewayResponse") and is always visible in the Paystack dashboard.
--
-- Idempotent: re-running it is a no-op.
--
-- Run in Supabase → SQL Editor, then reload the dashboard.

alter table public.transactions
  add column if not exists failure_reason text;

comment on column public.transactions.failure_reason is
  'Verbatim Paystack decline reason (gateway_response) for a FAILED transaction. NULL for settled or in-progress rows.';

-- Optional: makes "show me this month''s declines grouped by reason" cheap once
-- the table grows. Skip it if you do not run such reports.
-- create index if not exists transactions_failure_reason_idx
--   on public.transactions (failure_reason)
--   where failure_reason is not null;

-- VERIFY (should return one row):
--   select column_name, data_type
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name = 'transactions'
--     and column_name = 'failure_reason';
