# Rotating a tenant API key — zero downtime

**Audited:** 2026-09-04 · applies to `https://valmontpay.app`

Every tenant holds up to two API secrets at once (`secret_key_1`, `secret_key_2`). Both are accepted by `POST /api/transaction/initialize` while both are present. That is what makes rotation safe: you can put a new key into service, move the integration onto it, and only then retire the old one.

---

## 1. Is the Valmont Electricals dev credential live right now?

`vme_secret_dev_key_1` is committed in this repository, so anyone who has read the source can present it. Run this:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer vme_secret_dev_key_1" \
  https://valmontpay.app/api/transaction/verify/DOES-NOT-EXIST
```

| Response | Meaning |
|---|---|
| `401` | Safe. `TENANT__VALMONT_ELECTRICALS__SECRET_KEY_1` is set in Vercel, so the dev string is not accepted. |
| `404` | **The dev string is a live API credential.** Rotate now — see § 2 or § 3. |

(The reference deliberately does not exist: a `401` means the key was rejected, a `404` means the key was accepted and the lookup simply found nothing. Nothing is written either way.)

---

## 2. Fastest kill — pin the credential in the environment (≈2 minutes)

Set this in **Vercel → Project → Settings → Environment Variables** and redeploy:

```
TENANT__VALMONT_ELECTRICALS__SECRET_KEY_1 = <a fresh 40+ character random string>
```

Precedence is **env > database > in-code default**, so this overrides the database row the instant it deploys.

> ⚠️ **Read this before you also use the admin UI.** While that variable is set, it *replaces* the tenant's key list wholesale — `secret_key_2` from the database is no longer accepted either. The **Rotate keys** button in `/tenants.html` will appear to work and return new keys, but the environment variable still wins, so **nothing actually changes**. They are two sources of truth; pick one:
>
> - **Pin in Vercel** — best for a small, fixed set of merchants. Simple, auditable, survives database edits. Rotation means editing the variable and redeploying (§ 2.1).
> - **Rotate in the database** — best if operators manage merchants through `/tenants.html`. Leave the variable **unset**.

### 2.1 You do not have to remember any of this

Once `SECRET_KEY_1` is pinned, the **Rotate keys** button in `/tenants.html` is a no-op for that tenant — the environment overrides whatever the database holds. Rather than leaving you to remember that:

- the tenant row shows an amber **env-pinned** badge (hover it to see which variable), and
- if you press **Rotate keys** anyway, the API refuses with `409` and the page tells you **"Keys NOT rotated — nothing changed"**, names the variable, and says to edit it instead.

You cannot silently believe you rotated a key when you did not.

### 2.2 Zero-downtime swap while pinned

1. Set `TENANT__VALMONT_ELECTRICALS__SECRET_KEY_2=<new key>` alongside `SECRET_KEY_1`. Both are now accepted.
2. Update the integration to the **new** key.
3. Redeploy with `SECRET_KEY_1=<new key>` and delete `SECRET_KEY_2`. The old key is now dead.

---

## 3. Rotating through the database (≈5 minutes, two rotations)

Use this when no `TENANT__…__SECRET_KEY_1` variable is set.

`POST /api/admin/tenants/{key}/rotate-keys` (the **Rotate keys** button in `/tenants.html`) does:

```
secret_key_1 ← brand new key
secret_key_2 ← the PREVIOUS secret_key_1
```

So after **one** rotation the old key is still valid — that is the migration window, not a bug. A **second** rotation is what retires it.

1. **Rotate.** Note both values — they are shown once and never again.
   - new `secret_key_1` = your new key
   - new `secret_key_2` = the old key (still working)
2. **Roll out** the new `secret_key_1` to the integration. Verify a real payment or the `curl` check in § 4.
3. **Rotate again.** Now `secret_key_1` = another fresh key, `secret_key_2` = the key you rolled out in step 2, and the original key is **gone**.
4. **Roll out** the newest `secret_key_1`.

Done correctly, there is never a moment when the integration has no valid key.

---

## 4. Verify

```bash
curl -s -H "Authorization: Bearer <NEW_KEY>" \
  https://valmontpay.app/api/transaction/verify/DOES-NOT-EXIST
# expect 404 — the key is accepted

curl -s -H "Authorization: Bearer <OLD_KEY>" \
  https://valmontpay.app/api/transaction/verify/DOES-NOT-EXIST
# expect 401 — the key is dead
```

---

## 5. What changed in this branch

Three defects made this harder than it should have been:

**Rotation was not durable.** `POST /api/tenants/{key}/rotate-keys` rewrote the in-memory registry only. On Vercel the rotation evaporated at the next cold start while the database still held the old key — so an operator could "revoke" a leaked credential and watch it silently come back. It now persists to Supabase first (the same path `/api/admin/tenants/{key}/rotate-keys` always used) and returns `503` when there is no database to write to, instead of reporting a rotation that will not survive.

**A leaked key could survive a rotation forever.** The webhook signing secret and public key were never rotated at all; `rotateSecrets` moves the API secret only. If you believe a tenant's webhook signing secret leaked, set `TENANT__<KEY>__WEBHOOK_SIGNING_SECRET` explicitly — the env var wins.

**A fresh deployment could authenticate with a committed string.** The in-code dev credentials (`vme_secret_dev_key_1` and the dev webhook signing secret) now resolve to **empty in any deployed environment**, so a deployment with no configured credential fails closed instead of accepting a public string. Local runs and the test suite are unaffected. The SQL migration likewise no longer seeds a known value — new projects get a random secret (read it from the table, or hit *Rotate keys*, which shows the new value once).

---

## 6. Standing advice

- Never paste a tenant secret into a storefront, a mobile app, or anything a customer's browser can read. Server-to-server only.
- Prefer the access-code flow (`POST /api/transaction/initialize`) over any URL that carries an amount — see [`docs/tenant-integration.md`](tenant-integration.md).
- Rotate on a schedule, and immediately whenever someone with access leaves.
