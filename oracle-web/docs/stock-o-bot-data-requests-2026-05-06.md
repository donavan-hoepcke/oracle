# Data requests from `stock_o_bot`

Written 2026-05-06 by the stock_o_bot side. This doc captures specific fields and endpoints `stock_o_bot` would like oracle-web to expose so the Claude-driven decision layer can graduate two patterns out of the shadow menu and tighten its discretionary entry logic.

We're filing this as a request rather than a contract — oracle-web's authors know the codebase and the data sources better than we do, and may know cheaper ways to get the same information than what we describe here.

## Context

`stock_o_bot` consumes oracle-web over HTTP + WebSocket and trades a separate Alpaca paper account. Its decision layer (Claude Haiku → Sonnet → Opus tiered) reasons over the events oracle-web emits plus on-demand HTTP lookups against `/api/raw/scanner`, `/api/raw/symbols/<sym>`, `/api/raw/regime`, and `/api/raw/income-trader-tickers`.

Today's EOD self-reflection (see `stock_o_bot/docs/agent-feedback/2026-05-06-eod-reflection.md`) flagged four data gaps that block the agent from advancing common penny-stock patterns from "shadow-only menu" to "live rule with an enforceable evidence schema." Two of those gaps are oracle-web's domain. Two are external.

## Priority 1 — Premarket levels

**Why:** Block to graduating `gap_and_go` from `known_patterns.md` into `rule_catalog.yaml`. The rule needs a mechanically-checkable `evidence_schema` and that requires premarket high as a first-class field — not a derived guess from chat or `gapPercent`.

**Asked of oracle-web:** Expose premarket session extremes on the existing `/api/raw/symbols/<sym>` payload (or a new `/api/raw/symbols/<sym>/premarket` endpoint, if separating concerns is cleaner).

```jsonc
{
  "symbol": "AREB",
  "premarket": {
    "session_date": "2026-05-06",        // The trading day this PM session belongs to
    "high": 0.41,
    "low": 0.28,
    "vwap": 0.34,                         // Volume-weighted average over PM bars
    "volume": 1_240_000,                  // Already exposed via scanner; nice to have here too for self-contained lookups
    "first_print_at": "2026-05-06T08:00:00Z",
    "last_print_at": "2026-05-06T13:29:55Z",  // i.e., right before RTH open
    "as_of": "2026-05-06T13:30:01Z"       // When this snapshot was computed
  }
}
```

If the underlying data source only has 1-min PM bars, that's plenty — vwap and high/low are derivable from there.

**Already on the wire (don't break these):** `gapPercent`, `premarketVolume`, `floatMillions` from the scanner items. No need to duplicate.

## Priority 2 — Session VWAP

**Why:** Block to graduating `vwap_reclaim` from `known_patterns.md` to a live rule. The agent today can't tell "price reclaimed VWAP on volume" from "price wandered above the prior bar" because there's no VWAP value in any payload.

**Asked of oracle-web:** Add session VWAP to `/api/raw/symbols/<sym>`'s indicators block.

```jsonc
{
  "symbol": "WTO",
  "indicators": {
    "session_vwap": 2.41,
    "session_vwap_volume": 8_200_000,     // Cumulative session volume up to as_of
    "price_vs_vwap_pct": -0.83,           // (last - vwap) / vwap * 100
    "as_of": "2026-05-06T15:42:11Z"
  }
}
```

**Stretch — VWAP-reclaim detection:** if oracle-web is already running a per-symbol bar processor, it could optionally include a discrete reclaim event in its WebSocket stream:

```jsonc
{
  "type": "vwap_reclaim",
  "symbol": "WTO",
  "ts": "2026-05-06T15:42:11Z",
  "reclaim_price": 2.43,
  "reclaim_volume": 120_000,             // Volume on the reclaiming bar
  "session_vwap_at_reclaim": 2.40,
  "duration_below_min": 18,              // How long was the price below VWAP before reclaim?
  "session_low_since_break": 2.31
}
```

If the reclaim-event work is more than a half-day, just exposing `session_vwap` is enough — `stock_o_bot` can detect reclaims itself by comparing successive reads. The dedicated event is an optimization, not a blocker.

## Priority 3 — SEC filing aggregation per symbol

**Why:** The bot already receives individual `sec_filing` events on the WebSocket. But to enforce a "no recent dilution" filter on entries, the agent needs to ask "what filings has $WTO had in the last 30 days?" without scrolling through journaled events. This is a query/aggregation problem, not a data-acquisition problem — the events are already flowing.

**Asked of oracle-web:** Either
- (a) Expand `/api/raw/symbols/<sym>` to include a `recent_filings` summary, or
- (b) Add `/api/raw/symbols/<sym>/filings?since_days=30`.

```jsonc
{
  "symbol": "WTO",
  "recent_filings": [
    {
      "form_type": "S-1",
      "filed_at": "2026-04-28T20:15:00Z",
      "title": "Resale prospectus, 12.5M shares",
      "is_dilutive": true,
      "shares_offered": 12_500_000,
      "url": "https://www.sec.gov/...",
      "raw_filing_event_id": 18432       // Optional cross-ref into our journal
    },
    {
      "form_type": "8-K",
      "filed_at": "2026-04-25T13:01:00Z",
      "title": "Material agreement update",
      "is_dilutive": false,
      "url": "https://www.sec.gov/..."
    }
  ],
  "as_of": "2026-05-06T15:42:11Z"
}
```

`is_dilutive` is the field that does the real work — anything that increases share count (S-1, S-3 with new issuance, ATM offering announcements, PIPE) is a hard "no entry" filter for `stock_o_bot`. If oracle-web's existing parser doesn't classify dilutive vs. non-dilutive, the bot can do that itself given `form_type` + a brief `title` — but having the classification upstream means the rule on the bot side is one-line.

## Out of oracle-web's scope (FYI)

Two requests from the reflection that we believe should NOT live in oracle-web. Filing here so the boundary is documented:

### Short interest / borrow availability

The reflection asked for `get_short_interest(symbol) → { si_pct_float, days_to_cover, borrow_fee_pct, borrow_available, as_of }`.

These data come from FINRA's bi-monthly SI report (free, two-week lag) and broker-side borrow APIs (real-time, broker-specific). Neither is on the StocksToTrade page that oracle-web scrapes, so this is an entirely separate data integration. We'd build it on the bot side against Polygon's reference endpoints or an IBKR fundamental call, not as a request to oracle-web.

Mentioning here only to confirm we don't expect oracle-web to take this on.

### Intraday tick history for VWAP-reclaim detection

If we don't get the discrete `vwap_reclaim` event from priority 2, `stock_o_bot` would need to keep its own rolling intraday tick window per watched symbol to detect reclaims. That's a bot-side caching problem, not an oracle-web problem.

## Verification handoff

Once any of these ship, the bot side can confirm with:

```powershell
cd F:\github\stock_o_bot
.\.venv\Scripts\Activate.ps1

# Premarket levels arriving:
python -c "import asyncio, json; from stock_o_bot.ingestion.http_client import OracleHttpClient; \
  asyncio.run((lambda: (lambda c: print(json.dumps(asyncio.run(c.get_symbol('AREB')), indent=2)))(OracleHttpClient('http://localhost:3000')))())"

# Once the bot tools are wired:
python -m stock_o_bot tool-probe get_premarket_levels --symbol AREB
python -m stock_o_bot tool-probe get_session_vwap     --symbol WTO
python -m stock_o_bot tool-probe get_float_and_dilution --symbol WTO
```

Each tool will report the fields it's filling vs. fields it's defaulting to null with `reason: "data_source_not_wired"`. When `reason` disappears, the data is flowing.

## Roll-out preference

These are independent and can ship in any order. Priority 1 (premarket) unblocks the highest-value pattern (`gap_and_go`); priority 2 (session VWAP) is second; priority 3 (filings) is the slow burn — useful but the bot can also operate without it on the conservative side.

If it's easier to ship one as a single field at a time rather than a structured block, that's also fine — bot-side tools degrade gracefully on missing fields.
