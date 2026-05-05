# IBKR Client Portal Gateway Setup

This is what you do once on a machine that will run live with the IBKR
broker adapter (`broker.active: ibkr` in `config.yaml`). After it's set
up, the `IbkrAdapter` connects automatically.

## TL;DR

1. Have an IBKR account (paper account is fine — ID looks like `DU1234567`).
2. Download and run the **Client Portal Gateway** (a small Java app).
3. Authenticate it once via browser with your IBKR credentials + 2FA.
4. Set `broker.ibkr.account_id` in `config.yaml` to your account ID.
5. Keep the gateway running whenever the bot is running. Sessions expire
   after ~24 h and require manual re-auth — there is no programmatic
   workaround for the 2FA flow.

The whole flow is "one-time setup, then re-auth daily". It's clunkier
than Alpaca's API-key model but it's the price of trading with IBKR.

## 1. Open or paper-fund an IBKR account

If you already have an IBKR live account, **enable paper trading** under
*Account Management → Settings → Paper Trading Account* — it's free and
mirrors your live account's permissions. The paper account's ID prefix
is `DU` (e.g. `DU1234567`); the live ID is `U` (e.g. `U1234567`).

Both have the same API surface; only the ID and underlying balances
differ. Recommend running paper for at least a week before flipping live.

## 2. Install the Client Portal Gateway

The gateway is a Java app you run locally. It speaks to IBKR's servers
on your behalf and exposes a REST API on `https://localhost:5000` (default).

We **don't vendor IBKR's gateway in this repo** — it's their IP and the
license terms for redistribution aren't documented. Instead, run the
included installer:

```bash
cd oracle-web
npm run ibkr-gateway:install
```

That downloads the official zip from IBKR's CDN and unpacks it into
`oracle-web/vendor/ibkr-gateway/` (gitignored). Idempotent — safe to
re-run; pass `--force` (or `npm run ibkr-gateway:reinstall`) if IBKR
ships an update.

You also need **Java 8 or newer**. Most systems have it; check with
`java -version`. If missing, install [Adoptium Temurin](https://adoptium.net/)
(open-source builds of OpenJDK).

## 3. Start the gateway

From `oracle-web/vendor/ibkr-gateway/`:

**Windows (PowerShell):**
```powershell
bin\run.bat root\conf.yaml
```

**Unix:**
```bash
bin/run.sh root/conf.yaml
```

You'll see logs about the embedded server starting. Default port is 5000.
Leave the terminal open — the gateway is a foreground process.

## 4. Authenticate via browser

1. Open `https://localhost:5000` in any browser.
2. **Accept the self-signed-cert warning** (you'll see this every time you
   re-authenticate; the gateway uses a self-signed cert because it's
   localhost-only). Our adapter handles this on its end via
   `broker.ibkr.allow_self_signed_tls: true` (default).
3. Log in with your IBKR username + password, then complete 2FA on your
   IBKR mobile app or hardware token. This is the same flow as the
   regular IBKR portal.
4. After the 2FA prompt clears, the gateway shows "Client login succeeded".

You're authenticated. The session is now sticky as long as:
- The gateway process keeps running.
- Something (us — see `IbkrSession.tickle()`) hits `POST /tickle` at least
  once a minute.
- Less than 24 h has passed since auth.

## 5. Verify the gateway is reachable

```bash
curl -k https://localhost:5000/v1/api/iserver/auth/status
```

(`-k` skips cert verification — required for the self-signed cert.)

You should get a JSON response with `"authenticated": true`. If
`authenticated: false`, redo step 4 — your session lapsed.

## 6. Configure the bot

In `oracle-web/server/config.yaml`:

```yaml
broker:
  active: "ibkr"
  ibkr:
    base_url: "https://localhost:5000/v1/api"
    account_id: "DU1234567"          # your paper or live IBKR account ID
    cash_account: true               # set false for margin
    poll_session_keepalive_sec: 60
    conid_cache_path: ".ibkr-state/conid-cache.json"
    allow_self_signed_tls: true      # required for the localhost gateway
```

Restart the server. On startup the adapter:
- Pings `/tickle` once and starts the keepalive interval.
- Lazily resolves symbols → IBKR `conid` on first lookup, persisting to
  `.ibkr-state/conid-cache.json` so subsequent restarts don't re-resolve
  every symbol.

## 7. Run the smoke test before going live

```bash
cd oracle-web/server && npx tsx scripts/ibkr-smoke.ts
```

The smoke script exercises submit / poll / cancel / close against your
paper account. **Run this every time you change adapter code** — it's
the only check that talks to a real gateway.

If it fails, the most common causes are:

| Symptom | Fix |
|---|---|
| `IBKR GET /portfolio/{accountId}/summary failed: 401` | Session expired — redo browser auth |
| `IBKR submitOrder: unknown reply ID oXXX` | New IBKR warning — review and add to `AUTO_CONFIRM_REPLY_IDS` |
| `ConidAmbiguityError` | Symbol resolves to multiple primary listings — IBKR's data has dual-listed quirks. Add a manual override. |
| Connection refused on port 5000 | Gateway is not running. Restart it (step 3). |

## 8. Daily re-authentication

IBKR's session lifetime is **~24 hours regardless of activity**. Even if
our keepalive fires perfectly, after ~24 h you must:

1. Stop the bot.
2. Hit `https://localhost:5000` in a browser, log in again, complete 2FA.
3. Restart the bot.

There is no programmatic 2FA flow. This is by design — IBKR considers
2FA a hard requirement for live order entry. **Set a daily reminder**
or run on a schedule that intentionally pauses around your re-auth window.

## Limitations of v1

- No multi-account routing. One IBKR session per process.
- No options. STK only.
- No automatic conid TTL refresh — entries are 7 days fresh, then a
  background refresh fires on next lookup. There is a manual
  `--refresh-conid` CLI knob (TBD if needed).
- No hot-failover from IBKR to Alpaca. If the IBKR session dies, orders
  stop until you re-auth.

## See also

- `server/src/services/brokers/ibkrAdapter.ts` — the adapter
- `server/src/services/brokers/ibkrSession.ts` — keepalive
- `server/src/services/brokers/ibkrConidCache.ts` — symbol→conid map
- `docs/superpowers/specs/2026-05-04-broker-adapter-design.md` — full migration spec
