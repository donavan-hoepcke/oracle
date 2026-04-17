# Chrome Debug Setup for the Playwright Scraper

The Playwright ticker scraper (`tickerBotService.ts`) attaches to an existing Chrome instance via Chrome DevTools Protocol (CDP). Chrome must be launched with `--remote-debugging-port` for this to work, and the Oracle tool page must be logged in and open.

## Why an Isolated Profile

We launch Chrome with a project-scoped `--user-data-dir` for three reasons:

1. **Does not disturb your main browsing session.** Launching Chrome with `--remote-debugging-port` and your default profile forces you to close your existing Chrome first (the user-data lock prevents two instances from sharing a profile).
2. **Credentials live in one place.** Once you log into the StocksToTrade Oracle tool in this profile, Playwright can reconnect to it across restarts without re-authenticating.
3. **Keeps the automation traffic out of your normal browsing history.**

## Launch Command (PowerShell)

```powershell
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  -ArgumentList `
    "--remote-debugging-port=9223", `
    "--user-data-dir=F:\github\stock_alerts\oracle\oracle-web\.chrome-debug-profile", `
    "https://university.stockstotrade.com/page/oracle-tool"
```

## Verify It Worked

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:9223/json/version" -TimeoutSec 5
```

You should see a JSON response with `Browser`, `Protocol-Version`, and `webSocketDebuggerUrl`.

## First-Time Login

The isolated profile has no saved credentials. Navigate to the Oracle tool and log in manually. The session cookie persists across Chrome restarts as long as you keep using the same `--user-data-dir`.

## Server Config

`oracle-web/server/config.yaml` must match the port:

```yaml
bot:
  playwright:
    use_existing_chrome: true
    chrome_cdp_url: "http://127.0.0.1:9223"
```

## Known Issue: Playwright / Chrome Version Mismatch

As of 2026-04-17, `playwright@1.59.1` times out during `connectOverCDP` against `Chrome/147.0.7727.56` even though the underlying WebSocket handshake succeeds. The symptom is:

```
browserType.connectOverCDP: Timeout 30000ms exceeded.
  - <ws preparing> retrieving websocket url from http://127.0.0.1:9223
  - <ws connecting> ws://127.0.0.1:9223/devtools/browser/...
  - <ws connected> ws://127.0.0.1:9223/devtools/browser/...
```

Fix: upgrade Playwright to a version that supports Chrome 147's CDP protocol:

```bash
cd oracle-web/server
npm install playwright@latest
```

If the version bump breaks the scraper, a fallback is to talk to Chrome's CDP directly from a small Node script (see `docs/superpowers/specs/` for any planned fallbacks).
