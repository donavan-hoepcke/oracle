# Broker Adapter — Design Spec

> **Status:** Phase 1 implemented (interface + Alpaca adapter behind it). Phase 2 (IBKR adapter) and Phase 3 (settled-cash sizing) still planned.
>
> **Source of truth for the implemented surface is `server/src/types/broker.ts`** — if the type signatures shown later in this spec disagree with that file, trust the file. The "Components" section was written before implementation and may have small drift in field names; cross-check before coding to it.

## Context

`alpacaOrderService.ts` is the only broker integration. It is imported directly by `executionService.ts`, `tradeReconciliationService.ts`, the journal/scanner endpoints in `index.ts`, and the after-hours flatten path in `priceSocket.ts`. The Alpaca paper account simulates margin trading and therefore enforces FINRA Pattern Day Trading on accounts under $25k, which today blocks our flatten path after the third day-trade. Live trading on a true cash account would not hit this — but we are tightly coupled to the Alpaca SDK shape.

Two near-term goals motivate this spec:

1. Run live on an **IBKR cash account** so PDT does not apply (T+1 settlement is the only constraint).
2. Allow swapping or running multiple brokers behind a single adapter boundary so we can A/B real fills, fall back when one rejects, or compare execution quality.

## Goals

- Define a `BrokerAdapter` interface that captures everything `executionService` and friends need from a broker, in broker-neutral terms.
- Refactor the existing Alpaca implementation behind the interface with **zero behavior change** in Phase 1.
- Add an IBKR cash-account adapter in Phase 2 that uses the IBKR Client Portal Web API.
- Surface cash-account settlement state (settled vs unsettled cash) so `tradeFilterService` can avoid free-riding violations on cash accounts.
- Pick the active adapter via config; do not hard-code a broker anywhere downstream.

## Non-goals

- Multi-account live routing in a single process (one active broker per process for v1).
- IBKR margin or options support.
- Replacing the bar/quote data feed (Alpaca IEX/SIP stays as the price source for now; broker adapter is purely for orders, positions, and account state).
- Tax-lot tracking.

## Architecture

```
config.broker.active: "alpaca" | "ibkr"
            |
            v
    +------------------+
    |  brokerService   |  (factory; returns the active adapter as BrokerAdapter)
    +------------------+
            |
   +--------+---------+
   v                  v
+---------+    +-------------+
| Alpaca  |    |    IBKR     |
| Adapter |    |   Adapter   |
+---------+    +-------------+
   |                  |
   v                  v
Alpaca REST     IBKR Client Portal
                Gateway (local)
```

Downstream code (executionService, tradeReconciliationService, the journal endpoint) imports `brokerService` and depends only on `BrokerAdapter`. No file outside `services/brokers/` references `alpaca*` or `ibkr*` types.

## New Files

| File | Purpose |
|------|---------|
| `server/src/types/broker.ts` | Shared types: `BrokerAccount`, `BrokerPosition`, `BrokerOrder`, `SubmitOrderParams`, `BrokerAdapter`. |
| `server/src/services/brokers/index.ts` | Factory: reads `config.broker.active`, returns the adapter instance as `BrokerAdapter`. Exported as `brokerService`. |
| `server/src/services/brokers/alpacaAdapter.ts` | Existing `alpacaOrderService.ts` moved and renamed to `class AlpacaAdapter implements BrokerAdapter`. |
| `server/src/services/brokers/ibkrAdapter.ts` | New IBKR Client Portal Web API adapter. |
| `server/src/services/brokers/ibkrSession.ts` | Session keepalive heartbeat for the IBKR Client Portal Gateway. |
| `server/src/services/brokers/ibkrConidCache.ts` | Symbol → IBKR `conid` lookup cache (file-backed, refreshed lazily). |

## Modified Files

| File | Change |
|------|--------|
| `services/executionService.ts` | Replace `alpacaOrderService` imports with `brokerService`. Replace `AlpacaPosition` type with `BrokerPosition`. No logic changes in Phase 1. |
| `services/tradeReconciliationService.ts` | Same import swap. |
| `services/tradeFilterService.ts` | Phase 3: add settled-cash check when `account.isCashAccount` is true. |
| `websocket/priceSocket.ts` | Same import swap. |
| `index.ts` | Same import swap. |
| `config.ts` | Add `broker` config block (zod schema). |
| `config.yaml` | Add `broker.active` and per-adapter sections. |
| `.env` | Add IBKR session credentials when needed (paper account ID, gateway URL). |

## Components

### `BrokerAdapter` interface

```ts
export interface BrokerAccount {
  cash: number;
  portfolioValue: number;
  buyingPower: number;
  // Cash-account specific. Margin adapters set settledCash === cash and
  // unsettledCash === 0. tradeFilterService consults settledCash when
  // isCashAccount is true so we do not spend unsettled proceeds.
  settledCash: number;
  unsettledCash: number;
}

export interface BrokerPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
}

export type BrokerOrderStatus =
  | 'pending'    // submitted, broker has not yet acknowledged
  | 'accepted'   // broker has the order in its book
  | 'partial'    // partially filled
  | 'filled'     // fully filled
  | 'cancelled'  // cancelled by us or by the broker
  | 'rejected'   // broker rejected outright (PDT, insufficient funds, etc.)
  | 'expired';   // tif expired

export interface BrokerOrder {
  id: string;
  symbol: string;
  status: BrokerOrderStatus;
  side: 'buy' | 'sell';
  filledAvgPrice: number | null;
  filledQty: number | null;
  filledAt: string | null;   // ISO-8601
  submittedAt: string | null; // ISO-8601
  // Broker-native status string for log/debug. Never used for control flow.
  rawStatus?: string;
}

export interface SubmitOrderParams {
  symbol: string;
  qty: number;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  limitPrice?: number;
}

export interface BrokerAdapter {
  /** Stable identifier used in logs, config, recordings. */
  readonly name: 'alpaca' | 'ibkr';
  /** True if account is registered as a cash account at the broker. */
  readonly isCashAccount: boolean;

  getAccount(): Promise<BrokerAccount>;
  getPositions(): Promise<BrokerPosition[]>;
  getOpenOrders(): Promise<BrokerOrder[]>;
  /** All orders submitted on or after sinceIso. Used by wash-sale lookups. */
  getOrdersSince(sinceIso: string): Promise<BrokerOrder[]>;
  submitOrder(params: SubmitOrderParams): Promise<BrokerOrder>;
  getOrder(id: string): Promise<BrokerOrder>;
  cancelOrder(id: string): Promise<void>;
  closePosition(symbol: string): Promise<BrokerOrder>;
  closeAllPositions(): Promise<BrokerOrder[]>;
}
```

### `brokerService` factory

```ts
import { config } from '../config.js';
import { AlpacaAdapter } from './brokers/alpacaAdapter.js';
import { IbkrAdapter } from './brokers/ibkrAdapter.js';
import type { BrokerAdapter } from '../types/broker.js';

let cached: BrokerAdapter | null = null;

export function brokerService(): BrokerAdapter {
  if (cached) return cached;
  switch (config.broker.active) {
    case 'alpaca': cached = new AlpacaAdapter(config.broker.alpaca); break;
    case 'ibkr':   cached = new IbkrAdapter(config.broker.ibkr); break;
  }
  return cached;
}
```

Singleton-style to preserve the current call pattern (`alpacaOrderService.submitOrder(...)` becomes `brokerService().submitOrder(...)`).

### `AlpacaAdapter`

Mechanical port of today's `alpacaOrderService.ts`. The only behavioral additions:

- Set `name: 'alpaca'`.
- Set `isCashAccount` from `config.broker.alpaca.cash_account` (default `false`; the paper account is margin-style).
- Populate `settledCash` / `unsettledCash` on `getAccount()`. Alpaca's account endpoint exposes `cash` and `cash_withdrawable`; we map `settledCash = cash_withdrawable`, `unsettledCash = cash - cash_withdrawable`.
- Status normalization: Alpaca's `accepted | new | pending_new | pending_replace | filled | partially_filled | canceled | rejected | expired` → the `BrokerOrderStatus` enum.

### `IbkrAdapter`

Talks to the **IBKR Client Portal Web API** via the local Client Portal Gateway (`https://localhost:5000/v1/api` by default). The gateway is a Java process that the user starts separately and authenticates once via browser. It then issues a session cookie that the adapter rides on.

**Auth & session**
- The user authenticates the gateway manually (browser flow with 2FA). Session is then persistent for ~24h with keepalives.
- `ibkrSession.ts` runs a lightweight heartbeat: `POST /tickle` every `poll_session_keepalive_sec` (default 60s). If the session lapses, all order calls fail until the user re-authenticates; we surface this via a clear error rather than silently retry.

**Symbol → conid**
- IBKR identifies instruments by `conid` (contract ID), not ticker. `ibkrConidCache.ts` maintains a `Map<symbol, conid>` populated lazily via `GET /iserver/secdef/search?symbol=XYZ&secType=STK`. Cache is persisted to `.ibkr-state/conid-cache.json` so we don't re-resolve on restart.
- Multiple matches (ADRs, foreign listings) are filtered to NYSE / NASDAQ / ARCA primary listings. Ambiguity is logged and the adapter throws — better to surface a config issue than fill the wrong instrument.

**Account & positions**
- `getAccount()` → `GET /portfolio/{accountId}/summary`. We map: `cash → totalcashvalue`, `portfolioValue → equitywithloanvalue`, `buyingPower → buyingpower` (or `availablefunds` for cash accounts), `settledCash → settledcash`, `unsettledCash → cushion`. The exact field names will be verified during Phase 2.
- `getPositions()` → `GET /portfolio/{accountId}/positions/0`. Maps to `BrokerPosition` directly.

**Orders**
- `submitOrder(...)` → `POST /iserver/account/{accountId}/orders` with `{conid, orderType: 'MKT' | 'LMT', side: 'BUY' | 'SELL', quantity, tif: 'DAY', price?: limitPrice}`.
- IBKR returns a list of "order replies" that may require confirmation (e.g. price limit warnings). The adapter auto-confirms on the warning subset we have explicit allowlists for; everything else throws. This is the highest-risk part of the integration and gets the most careful test coverage.
- `getOrder(id)` → `GET /iserver/account/orders` filtered by `orderId`. Status normalization: `Submitted → accepted`, `PreSubmitted → pending`, `Filled → filled`, `Cancelled → cancelled`, `Rejected → rejected`, `Inactive → expired`.
- `cancelOrder(id)` → `DELETE /iserver/account/{accountId}/order/{id}`.
- `closePosition(symbol)` → resolve to conid, fetch current qty from positions, submit `MKT SELL qty` (or `BUY` if short).
- `closeAllPositions()` → fan out `closePosition` over all current positions; return the list of resulting orders.

**Cash-account semantics**
- `isCashAccount` reads `config.broker.ibkr.cash_account` (asserted true for our use).
- `getAccount()` populates `settledCash` from IBKR's `settledcash` field. **`tradeFilterService` will use `settledCash` instead of `buyingPower` when sizing entries on a cash account.** This is Phase 3.

**Rate limits**
- Client Portal Web API is documented at 50 req/sec. Our 30s polling loop is well under that even with 8 active positions. Adapter does not implement client-side throttling in v1; if we ever bump up, we add a queue.

**Error model**
- Every method translates IBKR errors into a small set of typed exceptions: `BrokerAuthError`, `BrokerRateLimitError`, `BrokerRejectedError`, `BrokerTransientError`. Existing executionService catch blocks already handle "broker rejected" gracefully (no phantom ledger entry); we wire IBKR rejections into the same path.

### Config

```yaml
# oracle-web/server/config.yaml
broker:
  active: "alpaca"   # "alpaca" | "ibkr"
  alpaca:
    paper: true
    cash_account: false   # paper is margin-style; live cash account → set true
  ibkr:
    enabled: false
    base_url: "https://localhost:5000/v1/api"
    account_id: "DU1234567"
    cash_account: true
    poll_session_keepalive_sec: 60
    conid_cache_path: ".ibkr-state/conid-cache.json"
```

`config.execution.paper` becomes a derived value (`broker.alpaca.paper && broker.active === 'alpaca'`) so the existing flag is preserved for log lines / UI badge.

### `tradeFilterService` settled-cash check (Phase 3)

Today the position sizer calls `account.buyingPower`. On a cash account that includes unsettled proceeds, which the broker will let you spend but the SEC will flag as a free-riding violation if you sell what you bought with unsettled cash before it settles. The fix:

```ts
const sizingCash = account.isCashAccount ? account.settledCash : account.buyingPower;
```

`tradeFilterService.calculatePositionSize` takes `sizingCash` instead of `buyingPower`. No other change.

## Migration Phases

### Phase 1 — Refactor Alpaca behind the interface (no behavior change)
1. Add `types/broker.ts` and `services/brokers/` directory.
2. Move existing `alpacaOrderService.ts` into `brokers/alpacaAdapter.ts`. Keep public surface identical apart from the type signature change.
3. Add `services/brokers/index.ts` factory exporting `brokerService()`.
4. Update all callers (`executionService`, `tradeReconciliationService`, `priceSocket`, `index.ts`) to use `brokerService()`.
5. Add `config.broker` schema; default `active: "alpaca"`.
6. Run full server test suite and manual paper-mode verification.

**Acceptance**: 512 server tests still pass; live paper run shows identical behavior to today.

### Phase 2 — IBKR adapter (paper)
1. Add `IbkrAdapter`, `ibkrSession`, `ibkrConidCache`.
2. Add unit tests for status normalization, conid cache, and order-reply auto-confirmation logic.
3. Add a manual integration test harness (`scripts/ibkr-smoke.ts`) that exercises submit / poll / cancel / close against an IBKR paper account. Not part of the automated suite.
4. Document the gateway-bring-up procedure in `docs/ibkr-setup.md` (analogous to `docs/chrome-debug-setup.md`).

**Acceptance**: Manual smoke test passes; switching `broker.active: "ibkr"` and running the engine against IBKR paper produces correct fills and trailing stop progression.

### Phase 3 — Cash-account settlement awareness
1. Extend `BrokerAccount` with `settledCash` / `unsettledCash` (already in the interface; populate it).
2. Update `tradeFilterService.calculatePositionSize` to use `settledCash` when `isCashAccount`.
3. Optional: emit a Journal-page warning when more than X% of capital is unsettled.

**Acceptance**: A cash-account run never produces a free-riding violation; sizing degrades gracefully when unsettled cash dominates.

### Phase 4 — Optional cleanup
- Move broker-specific types out of executionService comments.
- Add a `BrokerAdapter` mock helper in tests so we don't have to mock all 9 methods on every test.

## Risks & Open Questions

1. **IBKR Client Portal Gateway is a separate process** the user must keep running. Gateway crashes / session expiries are a real failure mode. Mitigation: explicit health-check endpoint surfaced on the dashboard StatusBar.
2. **Order-reply confirmation gates** in IBKR can silently block orders if the warning set changes. Mitigation: log every reply ID we don't auto-confirm; review weekly.
3. **conid resolution edge cases** — symbols that change identity (M&A, ticker reuse) can leave a stale cache entry. Mitigation: TTL on the cache (default 7 days) and a `--refresh-conid` CLI flag.
4. **Status normalization bugs** — the worst class of failure is misreading "rejected" as "filled". Tests cover the obvious mappings; the integration smoke test covers what tests can't.

**Open questions for the user:**

- a. Run IBKR live first, or paper first? (Recommend: paper for ≥1 week of parallel running before going live.)
- b. Single active broker per process, or simultaneous (e.g., paper-Alpaca + live-IBKR)? Multi-active is much heavier; v1 is single-active.
- c. Keep Alpaca as the paper default even after IBKR is live, or switch all paper to IBKR too? (Alpaca paper is faster to spin up; IBKR paper is closer to live for fill realism.)
- d. Settled-cash sizing strictness — block entries that would dip into unsettled, or warn-and-allow? (Recommend: block.)
