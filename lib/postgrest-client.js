/**
 * Dependency-free Supabase data client (PostgREST transport).
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * Supabase's REST endpoint IS PostgREST, and PostgREST is plain HTTP. That
 * means the ledger can be read and written with `fetch` alone — no npm
 * package, no bundler, nothing that a serverless build can forget to include.
 *
 * That matters because this deployment has twice shipped bundles in which
 * `require('@supabase/supabase-js')` failed (see the note in lib/supabase.js).
 * When that happens `getSupabaseClient()` returns null, every ledger read
 * returns "Supabase client is not available", `GET /api/transactions` 500s,
 * and dashboard.html renders a silent EMPTY ledger — the money is still in
 * the database, it is just invisible. On 2026-10-09 that is exactly how a
 * real GH₵55.00 ledger showed up as "nothing".
 *
 * This module is the LAST RESORT transport: lib/supabase.js keeps using the
 * official SDK when it loads, and only falls back to this client when the SDK
 * is missing or refuses to construct. Both transports expose the same
 * `.from(table).<chain> → { data, error, count }` surface, so callers
 * (lib/transaction-store.js, lib/tenant-store.js, …) need no changes.
 *
 * ── Supported surface ────────────────────────────────────────────────────
 * Only what this codebase actually uses:
 *   .select(columns?, { count?, head? }) .insert(rows) .upsert(rows, { onConflict })
 *   .update(values) .delete() .eq(col, val) .in(col, values)
 *   .order(col, { ascending }) .limit(n) .single() .maybeSingle()
 * Awaiting the chain resolves to `{ data, error, count, status }`; errors keep
 * PostgREST's own shape (`{ message, code, details, hint }`) so existing
 * checks for PGRST116 / PGRST205 / 42P01 keep working unchanged.
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.SUPABASE_REST_TIMEOUT_MS) || 15000;

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function encodeValue(value) {
  if (value === null || value === undefined) return 'null';
  return encodeURIComponent(String(value));
}

/** Parse the total out of a `Content-Range` header (`0-24/25`, or a star range). */
function countFromContentRange(header) {
  if (!header) return null;
  const match = String(header).match(/\/(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

/** Build the `{ message, code, details, hint }` error PostgREST callers expect. */
function errorFromBody(status, body) {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return {
      message: body.message || body.error || `HTTP ${status}`,
      code: body.code || null,
      details: body.details === undefined ? null : body.details,
      hint: body.hint === undefined ? null : body.hint
    };
  }
  return {
    message: typeof body === 'string' && body ? body : `HTTP ${status}`,
    code: null,
    details: null,
    hint: null
  };
}

function requestSignal(timeoutMs) {
  // AbortSignal.timeout exists on Node 18+ / every Vercel runtime we target,
  // but a missing helper must never become a hard dependency.
  if (typeof AbortSignal === 'function' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

class PostgrestQuery {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.operation = 'select'; // select | insert | upsert | update | delete
    this.selectColumns = null;
    this.filters = [];
    this.orderClause = null;
    this.limitCount = null;
    this.onConflict = null;
    this.countMode = null;
    this.isHead = false;
    this.resultMode = 'array'; // array | single | maybeSingle
    this.body = undefined;
  }

  select(columns, options = {}) {
    this.selectColumns = columns === undefined || columns === null ? '*' : String(columns);
    if (options.head) this.isHead = true;
    if (options.count) this.countMode = options.count;
    return this;
  }

  insert(values) {
    this.operation = 'insert';
    this.body = values;
    return this;
  }

  upsert(values, options = {}) {
    this.operation = 'upsert';
    this.body = values;
    this.onConflict = options && options.onConflict ? options.onConflict : null;
    return this;
  }

  update(values) {
    this.operation = 'update';
    this.body = values;
    return this;
  }

  delete() {
    this.operation = 'delete';
    return this;
  }

  eq(column, value) {
    this.filters.push({ column, op: 'eq', values: [value] });
    return this;
  }

  in(column, values) {
    this.filters.push({ column, op: 'in', values: Array.isArray(values) ? values : [values] });
    return this;
  }

  order(column, options = {}) {
    const ascending = options && options.ascending === false ? false : true;
    this.orderClause = `${column}.${ascending ? 'asc' : 'desc'}`;
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  single() {
    this.resultMode = 'single';
    return this;
  }

  maybeSingle() {
    this.resultMode = 'maybeSingle';
    return this;
  }

  method() {
    if (this.isHead) return 'HEAD';
    if (this.operation === 'insert' || this.operation === 'upsert') return 'POST';
    if (this.operation === 'update') return 'PATCH';
    if (this.operation === 'delete') return 'DELETE';
    return 'GET';
  }

  toUrl() {
    const url = new URL(`${this.client.restUrl}/${encodeURIComponent(this.table)}`);
    if (this.selectColumns) url.searchParams.set('select', this.selectColumns);
    for (const filter of this.filters) {
      const encoded = filter.values.map(encodeValue).join(',');
      url.searchParams.append(filter.column, filter.op === 'in' ? `in.(${encoded})` : `${filter.op}.${encoded}`);
    }
    if (this.orderClause) url.searchParams.set('order', this.orderClause);
    if (this.limitCount !== null && this.limitCount !== undefined) {
      url.searchParams.set('limit', String(this.limitCount));
    }
    if (this.operation === 'upsert' && this.onConflict) {
      url.searchParams.set('on_conflict', this.onConflict);
    }
    return url;
  }

  headers() {
    const headers = {
      apikey: this.client.key,
      Authorization: `Bearer ${this.client.key}`,
      Accept: 'application/json'
    };
    const prefer = [];
    if (this.countMode) prefer.push(`count=${this.countMode}`);
    if (this.operation === 'upsert') prefer.push('resolution=merge-duplicates');
    // PostgREST only returns written rows when the caller asks for them —
    // exactly like Supabase's `.select()` after a write.
    if (this.operation !== 'select' && this.selectColumns) prefer.push('return=representation');
    if (prefer.length) headers.Prefer = prefer.join(',');
    if (this.body !== undefined) headers['Content-Type'] = 'application/json';
    return headers;
  }

  async execute() {
    const method = this.method();
    const signal = requestSignal(this.client.timeoutMs);
    let response;
    try {
      response = await fetch(this.toUrl(), {
        method,
        headers: this.headers(),
        body: this.body === undefined ? undefined : JSON.stringify(this.body),
        signal
      });
    } catch (thrown) {
      const aborted = thrown && (thrown.name === 'TimeoutError' || thrown.name === 'AbortError');
      return {
        data: null,
        count: null,
        status: 0,
        error: {
          message: aborted
            ? `Supabase REST request timed out after ${this.client.timeoutMs}ms`
            : (thrown && thrown.message ? thrown.message : String(thrown)),
          code: aborted ? 'REST_TIMEOUT' : 'REST_REQUEST_FAILED',
          details: null,
          hint: null
        }
      };
    }

    const count = this.countMode
      ? countFromContentRange(response.headers.get('content-range'))
      : null;

    let body = null;
    if (method !== 'HEAD') {
      const text = await response.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch (_) {
          body = text;
        }
      }
    }

    if (!response.ok) {
      return { data: null, count, status: response.status, error: errorFromBody(response.status, body) };
    }

    let data = body;
    if (this.resultMode === 'single' || this.resultMode === 'maybeSingle') {
      const rows = Array.isArray(body) ? body : body ? [body] : [];
      if (this.resultMode === 'maybeSingle') {
        if (rows.length > 1) {
          return {
            data: null,
            count,
            status: response.status,
            error: {
              message: 'JSON object requested, multiple (or no) rows returned',
              code: 'PGRST116',
              details: `${rows.length} rows`,
              hint: null
            }
          };
        }
        data = rows.length ? rows[0] : null;
      } else if (rows.length !== 1) {
        return {
          data: null,
          count,
          status: response.status,
          error: {
            message: 'JSON object requested, multiple (or no) rows returned',
            code: 'PGRST116',
            details: rows.length ? `${rows.length} rows` : '0 rows',
            hint: null
          }
        };
      } else {
        data = rows[0];
      }
    }

    return { data, count, status: response.status, error: null };
  }

  // Makes the chain directly awaitable: `await client.from('t').select('*')`.
  then(onFulfilled, onRejected) {
    return this.execute().then(onFulfilled, onRejected);
  }

  catch(onRejected) {
    return this.execute().catch(onRejected);
  }
}

/**
 * Create a PostgREST-backed Supabase client.
 *
 * @param {object} args
 * @param {string} args.url        Supabase project URL (https://xxx.supabase.co)
 * @param {string} args.key        service-role or anon key
 * @param {number} [args.timeoutMs]
 * @returns {{ from: (table: string) => PostgrestQuery, transport: string, restUrl: string }}
 */
function createPostgrestClient({ url, key, timeoutMs } = {}) {
  const baseUrl = normalizeUrl(url);
  const apiKey = String(key || '').trim();
  if (!baseUrl || !apiKey) {
    throw new Error('PostgREST transport requires both SUPABASE_URL and an API key');
  }

  return {
    transport: 'rest-fallback',
    restUrl: `${baseUrl}/rest/v1`,
    key: apiKey,
    timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    from(table) {
      return new PostgrestQuery(this, table);
    }
  };
}

module.exports = {
  createPostgrestClient,
  PostgrestQuery,
  countFromContentRange,
  DEFAULT_TIMEOUT_MS
};
