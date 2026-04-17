# Plan

Historical plan for adapting the Oracle stack for the web UI + auto-trading bot. Retained as a record; the current state is captured in `CLAUDE.md` and `docs/superpowers/specs/`.

## Status

All items below are complete. The Excel watchlist path was removed (see commit `ec0a3a9`) — Playwright scraping of the StocksToTrade Oracle tool is the sole symbol source.

## Completed

- [x] Runtime bot control surface (start / stop, source switching).
- [x] Playwright source for websites that require manual login before symbol reads.
- [x] Quote, trend, and stair-step signal logic preserved.
- [x] API endpoints for bot lifecycle.
- [x] WebSocket payloads extended with bot status.
- [x] Frontend controls for lifecycle (split into Scraper and Execution groups).
- [x] Playwright ticker extraction with configurable selectors.
- [x] Configurable login + post-login navigation for Playwright source.
- [x] Preview endpoint to test DOM selectors.
- [x] Production selector and login URL wired for StocksToTrade Oracle tool.
- [x] End-to-end validation against live login flow.

## Superseded

- Excel watchlist flow — removed entirely. See `CLAUDE.md` for the current data flow.
- "Start Bot / Stop Bot" buttons — renamed to clearer scraper/execution controls.

## Workflow

See `CLAUDE.md` → Workflow Rule. Every change goes through a feature branch and PR.
