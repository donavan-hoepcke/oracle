# Auto-Execution Engine — Design Spec

## Context

Today's retrospective analysis of 20 Oracle picks showed that our strategies (Oracle Zone, Red Candle Theory, Momentum Continuation) could have netted +19.3% combined across 27 simulated trades. However, the current system only alerts — it does not trade. The bot also lacks pre-entry filters, leading to bad trades like HUBC (51% stop width) and a losing Red Candle strategy (-10.1% net from 7 trades, 6 losses).

This spec adds an execution layer that auto-trades via Alpaca's paper trading API, along with 4 pre-entry filters and a trailing stop system to improve trade quality.

## Architecture

```
PriceSocket (30s poll)
  -> RuleEngine scores candidates (with improved filters)
    -> TradeFilterService gates entry decisions
      -> ExecutionService manages trade lifecycle
        -> AlpacaOrderService places/cancels orders via Alpaca Paper API
```

### New Files

| File | Purpose |
|------|---------|
| `server/src/services/alpacaOrderService.ts` | Thin wrapper around Alpaca Trading API: account info, place/cancel orders, list positions |
| `server/src/services/tradeFilterService.ts` | Pre-entry gate: risk cap, capital limits, drawdown breaker, strategy-specific filters |
| `server/src/services/executionService.ts` | Trade lifecycle orchestrator: entry, trailing stop management, EOD flatten, trade ledger |

### Modified Files

| File | Change |
|------|--------|
| `ruleEngineService.ts` | Tighten Red Candle volume gate (1.15x -> 1.5x), lower momentum gap threshold (5% -> 3%), expose entry/stop/target on TradeCandidate |
| `priceSocket.ts` | Wire ExecutionService into the price polling loop |
| `config.ts` | Add `execution` config block with zod schema |
| `config.yaml` | Add `execution` config defaults |
| `server/src/index.ts` | Add `/api/trades` and `/api/execution/status` endpoints |

## Components

### AlpacaOrderService

Handles all Alpaca Trading API communication. Paper mode uses `https://paper-api.alpaca.markets`.

**Methods:**
- `getAccount()` — returns cash, portfolio value, buying power
- `getPositions()` — returns all open positions with current market value
- `submitOrder(symbol, qty, side, type, limitPrice?, stopPrice?)` — place an order; returns order ID
- `cancelOrder(orderId)` — cancel a pending order
- `closePosition(symbol)` — market sell entire position
- `closeAllPositions()` — flatten everything (for EOD or emergency)

**Auth:** Uses existing `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY` env vars. Paper endpoint is selected when `execution.paper: true` in config.

### TradeFilterService

Pre-entry gate that decides whether a TradeCandidate should become a real trade. Every candidate must pass ALL filters.

**Filters (checked in order):**

1. **Daily drawdown breaker** — if realized + unrealized losses today exceed 5% of starting equity, reject all entries for the rest of the day. This is checked first because it's a hard kill switch.

2. **Max positions** — if open positions >= `max_positions` (default 8), reject.

3. **Capital deployment cap** — if deployed capital > `max_capital_pct` (50%) of available cash, reject.

4. **Max risk percentage** — if `(entry - stop) / entry > max_risk_pct` (10%), reject. This filters out blown-out zones like HUBC (51% risk) and BIRD (81% risk).

5. **Strategy-specific filters:**
   - **Red Candle Theory**: reject if the reclaim bar volume < `red_candle_vol_mult` (1.5x) of avg recent volume.
   - **Momentum Continuation**: reject if gap from oracle `last` price < `momentum_gap_pct` (3%).

**Interface:**
```typescript
interface FilterResult {
  passed: boolean;
  reason: string | null;  // e.g., "risk_pct 51.2% exceeds max 10%"
}

filterCandidate(candidate: TradeCandidate, account: AccountState): FilterResult
```

### ExecutionService

Orchestrates the full trade lifecycle. Runs on every price poll (30s).

**State:**
```typescript
interface ActiveTrade {
  symbol: string;
  strategy: CandidateSetup;
  entryPrice: number;
  entryTime: Date;
  shares: number;
  initialStop: number;
  currentStop: number;
  target: number;
  riskPerShare: number;  // entry - initialStop
  orderId: string | null;
  status: 'pending' | 'filled' | 'exiting';
  trailingState: 'initial' | 'breakeven' | 'trailing';
}

interface TradeLedgerEntry {
  symbol: string;
  strategy: CandidateSetup;
  entryPrice: number;
  entryTime: Date;
  exitPrice: number;
  exitTime: Date;
  shares: number;
  pnl: number;
  pnlPct: number;
  rMultiple: number;
  exitReason: 'stop' | 'trailing_stop' | 'target' | 'eod' | 'circuit_breaker';
}
```

**Entry prices by strategy:**
- **Oracle Zone**: market order at current price (candidate is already in the zone).
- **Red Candle Theory**: limit buy at the candle high (reclaim level). If not filled within 30 minutes, cancel.
- **Momentum Continuation**: limit buy at the first-15-min high (breakout level). If not filled within 30 minutes, cancel.

**Entry flow (every 30s):**
1. Get ranked candidates from RuleEngine.
2. For each candidate not already in an active trade:
   a. Run through TradeFilterService — skip if rejected.
   b. Calculate position size: `shares = floor(riskPerTrade / (entry - stop))`.
   c. Place order via AlpacaOrderService (market for Oracle Zone, limit for Red Candle / Momentum).
   d. Add to active trades as `pending`.
3. Check pending orders — if filled, update status to `filled`. If pending > 30 minutes, cancel and remove.

**Management flow (every 30s):**
For each filled active trade:
1. Get current price from StockState.
2. Calculate current R-multiple: `(currentPrice - entryPrice) / riskPerShare`.
3. **Trailing stop logic:**
   - If R >= `trailing_start_r` (2.0): set `currentStop = currentPrice - (trailing_distance_r * riskPerShare)`. Mark state `trailing`.
   - Else if R >= `trailing_breakeven_r` (1.0): set `currentStop = entryPrice`. Mark state `breakeven`.
   - Else: `currentStop` stays at `initialStop`.
4. If `currentPrice <= currentStop`: submit market sell, log to ledger with appropriate exit reason.
5. If `currentPrice >= target`: submit market sell, log as `target`.

**EOD flatten:**
At `eod_flatten_time` (15:50 ET), close all remaining positions via market orders. Log each as `eod` exit.

**Circuit breaker:**
After each closed trade, recalculate daily P&L. If `dailyLoss / startOfDayEquity > max_daily_drawdown_pct`, set a flag that blocks all new entries until the next trading day.

### Position Sizing

Uses risk-based sizing:

```
riskPerShare = entryPrice - stopPrice
shares = floor(riskPerTrade / riskPerShare)
costBasis = shares * entryPrice
```

Before placing the order, verify:
- `costBasis` does not breach the 50% capital cap.
- `shares >= 1` (if risk is so wide that we can't even buy 1 share within our risk budget, skip).

### Config Schema

```yaml
execution:
  enabled: true
  paper: true
  risk_per_trade: 100
  max_positions: 8
  max_capital_pct: 0.50
  max_daily_drawdown_pct: 0.05
  max_risk_pct: 0.10
  red_candle_vol_mult: 1.5
  momentum_gap_pct: 0.03
  trailing_breakeven_r: 1.0
  trailing_start_r: 2.0
  trailing_distance_r: 1.0
  eod_flatten_time: "15:50"
```

All fields have defaults in the zod schema so the system works out of the box without adding the block to config.yaml.

### API Endpoints

**GET `/api/trades`**
Returns active trades and today's ledger:
```json
{
  "active": [{ "symbol": "AGAE", "strategy": "oracle_zone", "entryPrice": 0.436, "currentStop": 0.436, "trailingState": "breakeven", ... }],
  "closed": [{ "symbol": "ARAI", "exitReason": "stop", "pnl": -1.00, ... }],
  "dailyPnl": -1.00,
  "dailyPnlPct": -0.01,
  "circuitBreakerActive": false
}
```

**GET `/api/execution/status`**
Returns execution engine state:
```json
{
  "enabled": true,
  "paper": true,
  "openPositions": 3,
  "maxPositions": 8,
  "deployedCapital": 1500.00,
  "availableCash": 8500.00,
  "dailyPnl": 45.20,
  "circuitBreakerActive": false
}
```

**POST `/api/execution/toggle`**
Enable/disable the execution engine without restarting the server. Body: `{ "enabled": true|false }`.

**POST `/api/execution/flatten`**
Emergency flatten — close all positions immediately.

### RuleEngine Changes

1. **Red Candle volume gate**: Change the volume confirmation threshold from `1.15` to the configurable `red_candle_vol_mult` (default 1.5).

2. **Momentum gap threshold**: In `pickSetup()`, add a gap percentage check. When falling through to the `momentum_continuation` fallback, verify the stock's gap from its oracle `lastPrice` (the premarket snapshot stored on WatchlistItem/StockState) exceeds `momentum_gap_pct` (default 3%). If `lastPrice` is null or the gap is below threshold, don't assign momentum_continuation. Note: `lastPrice` is already scraped by Playwright and mapped through to StockState — no new data source needed.

3. **Expose entry/stop/target on TradeCandidate**: Add `suggestedEntry`, `suggestedStop`, `suggestedTarget` fields so the execution service knows the exact levels without re-deriving them.

### WebSocket Messages

Add a new message type for the frontend:

```typescript
| { type: 'trade_update'; data: { active: ActiveTrade[]; dailyPnl: number; circuitBreakerActive: boolean } }
```

Broadcast after every execution cycle so the UI can show live trade status.

## What This Does NOT Include

- **UI for trade management** — the existing dashboard shows alerts; trades will be visible via the API endpoints. A trade management UI is a follow-up.
- **Multi-day position holding** — all positions flatten at EOD.
- **Short selling** — long-only for now.
- **Live trading** — paper only. Switching to live requires changing `paper: false` in config, which swaps the Alpaca endpoint.

## Testing Strategy

1. **Unit tests** for TradeFilterService — each filter in isolation with edge cases.
2. **Unit tests** for position sizing — verify share calculation, capital cap enforcement, minimum 1 share.
3. **Integration test** for ExecutionService — mock AlpacaOrderService, simulate a full trade lifecycle (entry -> trailing stop adjustments -> exit).
4. **Manual paper trading** — run the bot during market hours against Alpaca paper account and review the `/api/trades` output.

## Success Criteria

Using today's data as a benchmark:
- The 4 filters should reduce trade count from 27 to ~15-18 (filtering HUBC, LRHC, BIRD, LAES on risk; most Red Candle trades on volume).
- Win rate should improve from 41% to >50%.
- Combined P&L should remain positive with fewer, higher-quality trades.
- Circuit breaker should never trigger on a normal day (5% is generous).
- Trailing stops should capture more profit from runners like AGAE (+18.9% EOD hold → should lock in gains along the way).
