# IBKR Client Portal Gateway Setup

The IBKR adapter (`server/src/services/brokers/ibkrAdapter.ts`) talks to a locally-running **Client Portal Gateway** — a Java process distributed by IBKR that proxies the REST API and handles the browser-based 2FA flow. This doc covers running paper and live gateways concurrently.

## Why Two Gateways

A Client Portal Gateway is bound to **one IBKR account session at a time**. Paper accounts (`DU...`) and live accounts (`U...`) are separate accounts, so you can run two gateways side-by-side — one for each — and switch the bot between them with a config flip.

| Profile | Default port | Default install dir | Account ID prefix |
|---|---|---|---|
| paper | 5000 | `oracle-web/vendor/ibkr-gateway-paper/` | `DU...` |
| live  | 5001 | `oracle-web/vendor/ibkr-gateway-live/`  | `U...` |

Both directories are gitignored.

## Prerequisites

- **Java 11+** on PATH. Check with `java -version`.
- **An IBKR account** for each profile you want to run. Paper accounts are free at https://www.interactivebrokers.com/en/trading/papertrader.php and don't require a funded live account first.
- **2FA on your phone** (IBKR mobile app or SMS). Required at least once per session.
- **Account IDs** for paper (`DU...`) and live (`U...`) — visible in your IBKR Client Portal under Settings → Account.

## Install

From `oracle-web/`:

```powershell
# Paper (port 5000) — recommended first
npm run ibkr-gateway:install:paper

# Live (port 5001) — only when you're ready to trade real money
npm run ibkr-gateway:install:live
```

The script downloads the official zip from IBKR's CDN, extracts it into `vendor/ibkr-gateway-{profile}/`, and patches `root/conf.yaml` so the gateway listens on the right port. To redownload after IBKR ships an update:

```powershell
npm run ibkr-gateway:reinstall:paper
npm run ibkr-gateway:reinstall:live
```

## Configure

Edit `oracle-web/server/config.yaml`:

```yaml
broker:
  active: "alpaca"          # "ibkr" once you're ready to use it
  ibkr:
    profile: "paper"        # "paper" or "live"
    profiles:
      paper:
        base_url: "https://localhost:5000/v1/api"
        account_id: "DU1234567"   # ← fill in your paper account ID
        cash_account: true
      live:
        base_url: "https://localhost:5001/v1/api"
        account_id: "U1234567"    # ← fill in your live account ID
        cash_account: true
```

Switching paper ↔ live is `profile: "..."` + backend restart. You can leave both gateways running; only the active profile is contacted.

## Run a Gateway

Each gateway is a separate process. Open one terminal per gateway:

```powershell
# Paper
F:\github\stock_alerts\oracle\oracle-web\vendor\ibkr-gateway-paper\bin\run.bat F:\github\stock_alerts\oracle\oracle-web\vendor\ibkr-gateway-paper\root\conf.yaml

# Live
F:\github\stock_alerts\oracle\oracle-web\vendor\ibkr-gateway-live\bin\run.bat F:\github\stock_alerts\oracle\oracle-web\vendor\ibkr-gateway-live\root\conf.yaml
```

Wait for `Server Started`. The gateway is now listening but **not yet authenticated**.

## Authenticate

Open the gateway's URL in a browser:

- Paper: https://localhost:5000
- Live: https://localhost:5001

Your browser will warn about the gateway's self-signed TLS cert — that's expected; click through. Log in with your IBKR username/password, then approve the 2FA tap on your phone.

You should see "Client login succeeds." Verify programmatically:

```powershell
# Paper
Invoke-RestMethod -Uri "https://localhost:5000/v1/api/iserver/auth/status" -SkipCertificateCheck

# Live
Invoke-RestMethod -Uri "https://localhost:5001/v1/api/iserver/auth/status" -SkipCertificateCheck
```

Look for `authenticated: true, connected: true`.

## Session Lifetime

- **Tickle keepalive:** the adapter pings `/tickle` every 60s (configurable). This keeps the session alive within IBKR's idle window.
- **Hard expiry:** IBKR forces re-authentication after ~24 hours regardless of activity. Plan for one browser-tap per day if you run continuously.
- **Crash recovery:** if the gateway process exits, restart it and re-authenticate. The bot's `IbkrSession` will surface a clear auth error rather than silently fail.

## Switching Active Broker

To flip the bot from Alpaca paper to IBKR paper:

1. Make sure the paper gateway is running and authenticated.
2. Set `broker.active: "ibkr"` and `broker.ibkr.profile: "paper"` in `config.yaml`.
3. Restart the backend (`npm run dev` from `oracle-web/server/`).

Going to live is the same flow with `profile: "live"`. Verify on a paper run for at least a session before flipping.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `connect ECONNREFUSED 127.0.0.1:5000` | Gateway not running | Start `bin/run.bat` |
| `401 Unauthorized` from any endpoint | Session expired or never authenticated | Browse to the gateway URL and re-auth |
| `403 trade denied due to pattern day trading protection` | Cash account flag mismatch — the broker thinks the account is margin | Confirm `cash_account: true` matches the actual account type registered at IBKR |
| `unable to verify the first certificate` errors in adapter logs | Self-signed TLS rejection | Set `broker.ibkr.allow_self_signed_tls: true` (the default) |
| Paper and live both want port 5000 | The reinstall script didn't patch `conf.yaml` | Edit `vendor/ibkr-gateway-live/root/conf.yaml` and set `listenPort: 5001` manually |
