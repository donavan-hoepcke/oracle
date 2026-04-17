# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Algorithmic stock trading suite with two tracks:

- **`oracle-web/`** — TypeScript full-stack app that is the primary system today. Node/Express + WebSocket server paired with a React/Vite/Tailwind frontend. Includes a Playwright scraper for the StocksToTrade Oracle tool, a rule engine, and an auto-execution engine that paper-trades via the Alpaca Trading API.
- **Python legacy** (`oracle/`, `premarket/scanners/`, `orb_trader/`) — original Tkinter monitor and CLI premarket scanners. Still runnable for reference but no longer actively developed.

## Workflow Rule

Everything must go through a feature branch + PR (`gh pr create`). Never commit directly to `main`. Use `gh pr merge N --squash --admin --delete-branch` after review, then `git checkout main && git pull` to sync.

## Oracle Web (primary)

### Running

```bash
# Backend (tsx watch on port 3001)
cd oracle-web/server
npm install
npm run dev

# Frontend (Vite on port 5173)
cd oracle-web
npm install
npm run dev
```

Chrome must be running with the remote-debugging port open before the scraper can attach — see `docs/chrome-debug-setup.md`.

### Tests / Typecheck

```bash
cd oracle-web/server && npx vitest run           # server unit tests
cd oracle-web/server && npx tsc --noEmit         # typecheck
cd oracle-web       && npm test                  # frontend tests
cd oracle-web       && npm run build             # build check
```

### Architecture

```
Chrome (debug port) -> Playwright scraper -> WatchlistItem
                                              |
                                              v
                               PriceSocket (30s poll)
                                              |
              +-----------------+-------------+----------------+
              v                 v                              v
        RuleEngine      ExecutionService                 WebSocket
       (candidates)   (trade lifecycle)             (clients / UI)
                            |
                            v
                    AlpacaOrderService (paper)
```

### Key Services (`oracle-web/server/src/services/`)

- `tickerBotService.ts` — Playwright scraper attached to Chrome via CDP. Reads the Oracle tool page and emits `WatchlistItem` records.
- `ruleEngineService.ts` — Scores each symbol against Oracle Zone, Red Candle Theory, and Momentum Continuation setups. Enforces gap/momentum chase/uptrend filters. Exposes `suggestedEntry`, `suggestedStop`, `suggestedTarget` on each `TradeCandidate`.
- `tradeFilterService.ts` — Pre-entry gates (daily drawdown, max positions, capital cap, max risk).
- `executionService.ts` — Trade lifecycle orchestrator. Adopts existing Alpaca positions on startup, caps reconciled stops at `max_risk_pct`, manages trailing stops, applies cooldown after stop exits, enforces wash-sale bar, runs EOD flatten.
- `alpacaOrderService.ts` — Alpaca Trading API wrapper (paper endpoint when `execution.paper: true`).

### Frontend Pages (`oracle-web/src/components/`)

- `ScannerPage.tsx` — Actionable scanner with status filter pills (TRADED / REJECTED / CANDIDATE / SETUP / BLOWN OUT / WATCH / DEAD), per-row `ZoneBar`, and a `30d` amber badge for wash-sale-flagged symbols.
- `JournalPage.tsx` — Live trading journal with account summary card and active/closed trade tables including rationale.
- `IdeasPage.tsx` — Candidate list with scoring breakdown and message context.

### API Endpoints (`oracle-web/server/src/index.ts`)

- `GET /api/scanner` — Full scanner snapshot (all symbols, all statuses, zone prices, wash-sale flag).
- `GET /api/trades` — Active + closed trades with rationale.
- `GET /api/execution/status` — Engine state (enabled, paper, positions, deployed capital, daily P&L).
- `POST /api/execution/toggle` — Enable/disable execution without restart.
- `POST /api/execution/flatten` — Emergency flatten of all positions.
- `GET /api/trade-candidates` — Current ranked candidates.

## Configuration

### Environment (`oracle-web/server/.env`)

```bash
APCA_API_KEY_ID=...        # Alpaca API key
APCA_API_SECRET_KEY=...    # Alpaca secret (paper account)
APCA_DATA_FEED=iex         # 'iex' (free) or 'sip' (paid)
```

### Server Config (`oracle-web/server/config.yaml`)

- `bot.playwright.chrome_cdp_url` — must match the `--remote-debugging-port` used when launching Chrome (9223 by default).
- `execution.*` — risk caps, position limits, wash-sale thresholds, trailing stop R-multiples, EOD flatten time. See `docs/superpowers/specs/2026-04-16-auto-execution-design.md` for semantics.

## Operational Runbook

1. Launch Chrome with the isolated debug profile (`docs/chrome-debug-setup.md`).
2. Log into the StocksToTrade Oracle tool in that Chrome window (first run only — session persists).
3. Start the server (`cd oracle-web/server && npm run dev`) and frontend (`cd oracle-web && npm run dev`).
4. Scraper auto-attaches via CDP; WebSocket streams price + trade updates to the UI.
5. Flip execution on via the toolbar toggle or `POST /api/execution/toggle`.

## Python Legacy

Still runnable but not actively maintained. Kept for reference and for the backtesting CSV format in the premarket ignition scanner.

```bash
cd oracle && python stock_monitor.py
cd premarket/scanners/premarket_ignition && python premarket_ignition.py --mode live --data-source alpaca --universe universe.txt --journal journal.csv
```

Requires Python 3.13+ (uses `zoneinfo`, `X | None` syntax).
