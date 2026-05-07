# Extended-Hours RCT Trading — Design Spec

> **Status:** Proposed. Not yet implemented.

## Context

The bot currently short-circuits its entire polling loop outside regular trading hours (`priceSocket.ts:309`: `if (!marketStatus.isOpen) { console.log('Market closed, skipping price fetch'); return; }`). No prices fetched, no rule-engine evaluation, no entries. Many of Bohen's Red-Candle-Theory (RCT) setups print pre-market and post-market — those signals are real edges that we currently can't act on.

This spec turns on RCT-only entries across Alpaca's full extended-hours window (pre 4:00–9:30 ET, post 16:00–20:00 ET) while keeping the rest of the trading loop conservative. The user's only constraint: "be careful with entries/exits" — extended hours are thin, spreads are wide, and bracket OCO doesn't fire there, so the bot has to manage exits in-process and size accordingly.

## Goals

- Detect and enter RCT setups in pre-market (04:00–09:30 ET) and post-market (16:00–20:00 ET) on weekdays.
- Use limit-only orders with the `extended_hours: true` Alpaca flag — Alpaca rejects market orders and bracket OCO outside RTH.
- Manage stops/targets in-process during ext-hours; cross to bracket OCO when RTH opens (Phase 2).
- Cap ext-hours position size to a configurable fraction of normal sizing.
- Refuse new entries in the last N minutes of post-market (no time left to manage an exit before the session ends).

## Non-goals

- Other strategies during ext-hours. Momentum continuation, ORB, pullback-reclaim all stay RTH-only — their signals depend on intraday volume / opening-range mechanics that don't translate to thin sessions.
- Holding positions overnight intentionally. EOD flatten still runs at 15:50 ET (RTH boundary). Ext-hours-entered positions must close within the same broader session unless explicitly held by an operator.
- Pre-market scanner / "watchlist hot symbols" UI. The dashboard's Active-Trades strip already surfaces ext-hours positions because they're in `activeTrades` — no new UI surface needed for v1.

## Architecture

```
priceSocket.fetchPrices() (every 30s)
  ├── getExtendedMarketStatus()  ← NEW (replaces isOpen check)
  │     returns { session: 'pre' | 'rth' | 'post' | 'closed' }
  │
  ├── if session === 'closed': skip everything, log, return  (existing behavior weekends/overnight)
  │
  ├── reconcileBrokerPositions      ← always runs (catches broker-side closes)
  │
  ├── EOD flatten check             ← only fires during RTH window (unchanged)
  │
  ├── price fetch via getPrices     ← runs in pre/rth/post
  │
  ├── stair-step / sector / regime  ← ALL skipped in pre/post (RTH signals only)
  │
  ├── ruleEngineService.getRankedCandidates(stocks, limit, regime, session)  ← session added
  │     in pre/post: only RCT candidates emitted; pickSetup short-circuits other setups
  │
  └── executionService.evaluateNewEntries(candidates, ..., session)   ← session added
        in pre/post:
          - tradeFilterService rejects non-RCT
          - position size capped to size_cap_pct * normal
          - submitBracketOrder REPLACED with submitLimitOrder({ extendedHours: true })
          - in-memory ActiveTrade has stopOrderId='' / targetOrderId='' so manageFilled
            uses the legacy bot-managed exit path (already the right code path for
            adopted-without-bracket trades)
```

The session enum threads through one parameter on each layer; no new service is introduced.

## New files

| File | Purpose |
|------|---------|
| _none_ | All changes are extensions to existing modules. |

## Modified files

| File | Change |
|------|--------|
| `services/marketHoursService.ts` | Add `getMarketSession()` returning `'pre' \| 'rth' \| 'post' \| 'closed'` and `isExtendedHours()`. Existing `getMarketStatus()` kept; its `isOpen` boolean still means RTH-only. |
| `websocket/priceSocket.ts` | Replace the `!isOpen` short-circuit with a session branch: `closed` → return as today; `pre`/`rth`/`post` → continue polling, but skip stair-step/sector/regime updates outside RTH. |
| `services/ruleEngineService.ts` | `getRankedCandidates` and `evaluateStock` take an optional `session` param; `pickSetup` returns `null` for any non-RCT setup when session is `'pre' \| 'post'`. |
| `services/tradeFilterService.ts` | Add session-aware filter: reject if session is `'pre' \| 'post'` AND candidate is non-RCT; reject if session is `'post'` AND now is within `no_entry_buffer_minutes_before_close` of post-market close. |
| `services/executionService.ts` | `evaluateNewEntries` takes session. Ext-hours path uses `submitOrder` (limit + extended_hours) instead of `submitBracketOrder`. Position sizing scaled by `size_cap_pct`. ActiveTrade is created with empty bracket-leg ids so the legacy in-process exit path runs in `manageFilled`. |
| `services/brokers/alpacaAdapter.ts` | `submitOrder` accepts an optional `extendedHours: boolean`; when true, sets the Alpaca order body's `extended_hours: true` flag and rejects non-limit types. |
| `types/broker.ts` | Add `extendedHours?: boolean` to the limit variant of `SubmitOrderParams`. |
| `config.ts` / `config.yaml` | New `execution.extended_hours` config block. |

## Components

### `marketHoursService.ts`

```ts
export type MarketSession = 'pre' | 'rth' | 'post' | 'closed';

/** Returns the current session in the configured timezone, accounting
 *  for weekday/weekend. Pre is 04:00-09:30, RTH is 09:30-16:00,
 *  post is 16:00-20:00. Outside those (and on weekends) → 'closed'. */
export function getMarketSession(now?: Date): MarketSession;

/** Convenience: getMarketSession() ∈ {'pre','post'}. */
export function isExtendedHours(now?: Date): boolean;
```

### Order submission path (`alpacaAdapter.ts`)

```ts
async submitOrder(params: SubmitOrderParams): Promise<BrokerOrder> {
  if (params.extendedHours && params.type !== 'limit') {
    throw new Error('extended-hours orders must be limit orders (Alpaca constraint)');
  }
  const body: Record<string, string | boolean> = {
    symbol: params.symbol,
    qty: String(params.qty),
    side: params.side,
    type: params.type,
    time_in_force: 'day',
  };
  if (params.type === 'limit') body.limit_price = String(params.limitPrice);
  if (params.extendedHours) body.extended_hours = true;
  // ...rest unchanged
}
```

### Entry path (`executionService.evaluateNewEntries`)

```ts
const session = getMarketSession();
const isExt = session === 'pre' || session === 'post';
const sizeMult = isExt ? config.execution.extended_hours.size_cap_pct : 1.0;
const sized = { ...size, shares: Math.floor(size.shares * sizeMult), costBasis: size.costBasis * sizeMult };

if (isExt) {
  // Bracket OCO doesn't fire ext-hours at Alpaca. Use a simple limit
  // entry; the in-process exit path takes over via manageFilled.
  const entry = await brokerService.submitOrder({
    symbol: candidate.symbol,
    qty: sized.shares,
    side: 'buy',
    type: 'limit',
    limitPrice: candidate.suggestedEntry,
    extendedHours: true,
  });
  // ActiveTrade with empty bracket-leg ids → manageFilled's legacy path
  // owns stop/target checks every cycle.
  this.activeTrades.push({
    /* ...standard fields... */
    targetOrderId: null,
    stopOrderId: null,
    lastBrokerStop: -Infinity,
    /* ... */
  });
} else {
  // RTH path unchanged — bracket OCO entry.
  const bracket = await brokerService.submitBracketOrder(...);
  /* ... */
}
```

### Stop-buffer adjustment

To account for wider ext-hours spreads, the suggested stop is widened by `stop_buffer_pct` before the entry is placed:

```ts
const stopBuffer = isExt ? config.execution.extended_hours.stop_buffer_pct : 0;
const adjustedStop = candidate.suggestedStop * (1 - stopBuffer);  // for long: stop further BELOW
```

Stored in the ActiveTrade as the working stop. The original RCT stop is in `rationale` for audit.

### Config

```yaml
execution:
  # ...existing keys...
  extended_hours:
    enabled: true
    pre_start: "04:00"
    pre_end: "09:30"
    post_start: "16:00"
    post_end: "20:00"
    # Refuse new entries in the last N min of post-market — no time left
    # to manage an exit before the session ends.
    no_entry_buffer_minutes_before_close: 15
    # Position size cap during ext-hours, as a fraction of normal sizing.
    size_cap_pct: 0.50
    # Widen the entry-time stop by this fraction of risk distance to
    # absorb thin-session spread / slippage.
    stop_buffer_pct: 0.25
```

## Error handling & edge cases

| Case | Behavior |
|---|---|
| Limit price unfilled before session ends | Order remains open; `cancelStaleOrders` cancels per existing `PENDING_TIMEOUT_MS` rule. Position size is 0 → no exposure. |
| Partial fill ext-hours | `checkPendingOrders` already handles partial → filled transitions correctly. ActiveTrade `shares` reflects the partial; bot manages the partial. |
| Post-market closes with an ext-hours position open | Bot continues managing in-process. Position is held overnight at risk if pre-market polls don't run before next-day RTH. Mitigation: pre-market polling resumes at 4:00am, manageFilled fires on first cycle, exits if stop hit or target reached. |
| RTH opens with an ext-hours position still open | Bot continues managing in-process for now. Phase 2 promotes to bracket OCO at the next RTH cycle. Until then: legacy stop/target check runs as on adopted-orphan trades today. |
| Ext-hours entry fires during the no-entry buffer (last 15 min of post) | `tradeFilterService` rejects with reason "ext-hours late-session buffer (Xm before close)". |
| `extended_hours: true` rejected by Alpaca for non-tradable symbol | Existing `submitOrder` error path: throws, executionService logs, no ActiveTrade is created. |

## Testing

- `marketHoursService.test.ts`: verify session boundaries (e.g., 09:29 → 'pre', 09:30 → 'rth', 15:59 → 'rth', 16:00 → 'post', 19:59 → 'post', 20:00 → 'closed', weekend → 'closed').
- `tradeFilterService.test.ts`: ext-hours rejects non-RCT candidates; ext-hours rejects within last-15-min window; RCT passes outside that window.
- `executionService.test.ts`: ext-hours session entry uses `submitOrder` with `extendedHours: true` (NOT `submitBracketOrder`); position size reduced by `size_cap_pct`; ActiveTrade has null bracket-leg ids so manageFilled handles exits in-process.
- `alpacaAdapter.test.ts`: `submitOrder({ extendedHours: true, type: 'limit' })` adds `extended_hours: true` to the body; throws on `extendedHours: true` with non-limit type.
- `priceSocket.ts`: covered by integration test that mocks the clock to a pre-market time and verifies that `getPrices` is called and stair-step is NOT called.

## Risks & open questions

1. **Liquidity is genuinely thin.** Even with the size cap and stop buffer, ext-hours fills can slip 5-10% on small caps. Acceptable for v1 — we're trading off liquidity risk against catching the move at all. Operators see live fills via the dashboard and can pause execution if it goes sideways.
2. **No bracket safety net.** RTH bracket OCO is a real protection — if the bot crashes the broker still has the exit queued. Ext-hours has no equivalent. Mitigation: short polling cadence (already 30s), eager ledger persistence (PR #85), and the operator can `flatten` via dashboard if they see the bot has died.
3. **Gap risk through session boundaries.** A position held from post-market into next-day pre-market opens to the first 4am tick. If price gaps far below the stop, the bot fires its stop on the first cycle but at the gap-down price — no protection from the gap itself. Same risk shape as adopted-orphan trades today. Will be revisited in Phase 2 with the bracket-on-RTH-open path.
4. **News-driven moves.** Earnings releases drop after 4pm; pre-market often gaps massively on overnight news. RCT signals printed RIGHT before/after such news are noisy. Operator-side discipline only — no automated guard in v1.

## Phase 2 (out of scope, noted)

- **Bracket promotion at RTH open.** When an ext-hours position carries over into RTH, place an OCO bracket at the next-RTH cycle so the broker takes over exit management. Cancels the in-process stop/target check.
- **Pre-RTH cancel-and-resubmit.** If a limit entry is still working at 09:29:30 ET, cancel and resubmit as RTH bracket so the position has a server-side OCO from second-one of regular hours.

## Open questions (please confirm before implementation)

- a. Confirm `size_cap_pct: 0.50` (half normal sizing) and `stop_buffer_pct: 0.25` (25% wider stop). Both tunable; these are starting points.
- b. The `no_entry_buffer_minutes_before_close: 15` — apply only to post-market, or also to pre-market (refuse entry in the last 15 min of pre too)? Pre-market last 15 min is 09:15–09:30 — gives the position only 15 min before RTH bracket promotion, which is fine. I'd default to **post-only** since pre→RTH is a smooth handoff. Confirm.
- c. Phase 2 bracket promotion — ship as part of this PR or as a follow-up? My lean: follow-up. Ship the entry path first; observe behavior; then add the promotion if it's the right call.
