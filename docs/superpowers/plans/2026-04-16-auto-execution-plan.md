# Auto-Execution Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add paper-trading auto-execution to the Oracle bot with risk-based position sizing, trailing stops, and pre-entry quality filters.

**Architecture:** Three new services layered on the existing price polling loop. `AlpacaOrderService` wraps the Alpaca Trading API. `TradeFilterService` gates entries. `ExecutionService` orchestrates the trade lifecycle (entry, trailing stops, EOD flatten). The rule engine gets tighter filters and exposes suggested entry/stop/target on each candidate.

**Tech Stack:** TypeScript, Vitest, Alpaca Trading API v2 (paper), Zod config validation.

**Spec:** `docs/superpowers/specs/2026-04-16-auto-execution-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server/src/services/alpacaOrderService.ts` | Create | Alpaca Trading API wrapper: account, orders, positions |
| `server/src/services/tradeFilterService.ts` | Create | Pre-entry gate: risk cap, capital limits, drawdown, strategy filters |
| `server/src/services/executionService.ts` | Create | Trade lifecycle: entry, trailing stop, EOD flatten, ledger |
| `server/src/__tests__/tradeFilterService.test.ts` | Create | Unit tests for all 5 filter gates |
| `server/src/__tests__/executionService.test.ts` | Create | Trade lifecycle tests with mocked order service |
| `server/src/__tests__/alpacaOrderService.test.ts` | Create | URL construction and response mapping tests |
| `server/src/services/ruleEngineService.ts` | Modify | Tighten volume gate, add gap filter, expose suggested levels |
| `server/src/websocket/priceSocket.ts` | Modify | Wire execution service into price poll and add trade_update broadcast |
| `server/src/config.ts` | Modify | Add `execution` zod schema block |
| `server/config.yaml` | Modify | Add `execution` config defaults |
| `server/src/index.ts` | Modify | Add `/api/trades`, `/api/execution/status`, `/api/execution/toggle`, `/api/execution/flatten` |

---

### Task 1: Add execution config block

**Files:**
- Modify: `server/src/config.ts`
- Modify: `server/config.yaml`

- [ ] **Step 1: Add zod schema for execution config in `config.ts`**

In `server/src/config.ts`, add the execution block inside `configSchema` after the `bot` field:

```typescript
  execution: z
    .object({
      enabled: z.boolean().default(false),
      paper: z.boolean().default(true),
      risk_per_trade: z.number().positive().default(100),
      max_positions: z.number().int().positive().default(8),
      max_capital_pct: z.number().min(0.01).max(1).default(0.5),
      max_daily_drawdown_pct: z.number().min(0.01).max(1).default(0.05),
      max_risk_pct: z.number().min(0.01).max(1).default(0.1),
      red_candle_vol_mult: z.number().positive().default(1.5),
      momentum_gap_pct: z.number().min(0).max(1).default(0.03),
      trailing_breakeven_r: z.number().positive().default(1.0),
      trailing_start_r: z.number().positive().default(2.0),
      trailing_distance_r: z.number().positive().default(1.0),
      eod_flatten_time: z.string().regex(/^\d{2}:\d{2}$/).default('15:50'),
    })
    .default({}),
```

- [ ] **Step 2: Add execution config to `config.yaml`**

Add at the end of `server/config.yaml`:

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

- [ ] **Step 3: Verify config loads**

Run: `cd oracle-web/server && npx tsx -e "import { config } from './src/config.js'; console.log(JSON.stringify(config.execution, null, 2))"`

Expected: JSON output showing all execution config fields with the values from config.yaml.

- [ ] **Step 4: Commit**

```bash
git add server/src/config.ts server/config.yaml
git commit -m "feat: add execution config block for auto-trading"
```

---

### Task 2: Create AlpacaOrderService

**Files:**
- Create: `server/src/services/alpacaOrderService.ts`
- Create: `server/src/__tests__/alpacaOrderService.test.ts`

- [ ] **Step 1: Write failing tests for AlpacaOrderService**

Create `server/src/__tests__/alpacaOrderService.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock config
vi.mock('../config.js', () => ({
  config: { execution: { paper: true } },
  alpacaApiKeyId: 'test-key',
  alpacaApiSecretKey: 'test-secret',
}));

import { alpacaOrderService } from '../services/alpacaOrderService.js';

beforeEach(() => {
  mockFetch.mockReset();
});

describe('AlpacaOrderService', () => {
  describe('getAccount', () => {
    it('fetches account from paper endpoint when paper mode', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ cash: '10000.00', portfolio_value: '10000.00', buying_power: '10000.00' }),
      });

      const account = await alpacaOrderService.getAccount();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://paper-api.alpaca.markets/v2/account',
        expect.objectContaining({
          headers: expect.objectContaining({
            'APCA-API-KEY-ID': 'test-key',
            'APCA-API-SECRET-KEY': 'test-secret',
          }),
        }),
      );
      expect(account.cash).toBe(10000);
      expect(account.portfolioValue).toBe(10000);
    });
  });

  describe('submitOrder', () => {
    it('submits a market buy order', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'order-123', status: 'accepted', filled_avg_price: null }),
      });

      const order = await alpacaOrderService.submitOrder({
        symbol: 'AGAE',
        qty: 100,
        side: 'buy',
        type: 'market',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.symbol).toBe('AGAE');
      expect(body.qty).toBe('100');
      expect(body.side).toBe('buy');
      expect(body.type).toBe('market');
      expect(body.time_in_force).toBe('day');
      expect(order.id).toBe('order-123');
    });

    it('submits a limit buy order with limit price', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'order-456', status: 'accepted', filled_avg_price: null }),
      });

      const order = await alpacaOrderService.submitOrder({
        symbol: 'IMMP',
        qty: 50,
        side: 'buy',
        type: 'limit',
        limitPrice: 0.58,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.type).toBe('limit');
      expect(body.limit_price).toBe('0.58');
      expect(order.id).toBe('order-456');
    });
  });

  describe('getPositions', () => {
    it('maps position response to typed objects', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { symbol: 'AGAE', qty: '100', avg_entry_price: '0.44', current_price: '0.52', market_value: '52.00', unrealized_pl: '8.00' },
        ],
      });

      const positions = await alpacaOrderService.getPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0].symbol).toBe('AGAE');
      expect(positions[0].qty).toBe(100);
      expect(positions[0].avgEntryPrice).toBe(0.44);
      expect(positions[0].currentPrice).toBe(0.52);
      expect(positions[0].unrealizedPl).toBe(8);
    });
  });

  describe('cancelOrder', () => {
    it('sends DELETE to order endpoint', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await alpacaOrderService.cancelOrder('order-123');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://paper-api.alpaca.markets/v2/orders/order-123',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('closePosition', () => {
    it('sends DELETE to position endpoint', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await alpacaOrderService.closePosition('AGAE');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://paper-api.alpaca.markets/v2/positions/AGAE',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('closeAllPositions', () => {
    it('sends DELETE to positions endpoint', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await alpacaOrderService.closeAllPositions();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://paper-api.alpaca.markets/v2/positions',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('getOrder', () => {
    it('fetches order by ID', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'order-123', status: 'filled', filled_avg_price: '0.45', filled_qty: '100' }),
      });

      const order = await alpacaOrderService.getOrder('order-123');
      expect(order.id).toBe('order-123');
      expect(order.status).toBe('filled');
      expect(order.filledAvgPrice).toBe(0.45);
      expect(order.filledQty).toBe(100);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd oracle-web/server && npx vitest run src/__tests__/alpacaOrderService.test.ts`

Expected: FAIL — module `../services/alpacaOrderService.js` not found.

- [ ] **Step 3: Implement AlpacaOrderService**

Create `server/src/services/alpacaOrderService.ts`:

```typescript
import { config, alpacaApiKeyId, alpacaApiSecretKey } from '../config.js';

const PAPER_BASE = 'https://paper-api.alpaca.markets/v2';
const LIVE_BASE = 'https://api.alpaca.markets/v2';

function baseUrl(): string {
  return config.execution.paper ? PAPER_BASE : LIVE_BASE;
}

function headers(): Record<string, string> {
  return {
    'APCA-API-KEY-ID': alpacaApiKeyId,
    'APCA-API-SECRET-KEY': alpacaApiSecretKey,
    'Content-Type': 'application/json',
  };
}

export interface AlpacaAccount {
  cash: number;
  portfolioValue: number;
  buyingPower: number;
}

export interface AlpacaPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
}

export interface AlpacaOrder {
  id: string;
  status: string;
  filledAvgPrice: number | null;
  filledQty: number | null;
}

export interface SubmitOrderParams {
  symbol: string;
  qty: number;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  limitPrice?: number;
}

class AlpacaOrderService {
  async getAccount(): Promise<AlpacaAccount> {
    const res = await fetch(`${baseUrl()}/account`, { headers: headers() });
    if (!res.ok) throw new Error(`Alpaca account error: ${res.status}`);
    const data = await res.json();
    return {
      cash: parseFloat(data.cash),
      portfolioValue: parseFloat(data.portfolio_value),
      buyingPower: parseFloat(data.buying_power),
    };
  }

  async getPositions(): Promise<AlpacaPosition[]> {
    const res = await fetch(`${baseUrl()}/positions`, { headers: headers() });
    if (!res.ok) throw new Error(`Alpaca positions error: ${res.status}`);
    const data = await res.json();
    return data.map((p: Record<string, string>) => ({
      symbol: p.symbol,
      qty: parseFloat(p.qty),
      avgEntryPrice: parseFloat(p.avg_entry_price),
      currentPrice: parseFloat(p.current_price),
      marketValue: parseFloat(p.market_value),
      unrealizedPl: parseFloat(p.unrealized_pl),
    }));
  }

  async submitOrder(params: SubmitOrderParams): Promise<AlpacaOrder> {
    const body: Record<string, string> = {
      symbol: params.symbol,
      qty: String(params.qty),
      side: params.side,
      type: params.type,
      time_in_force: 'day',
    };
    if (params.type === 'limit' && params.limitPrice !== undefined) {
      body.limit_price = String(params.limitPrice);
    }
    const res = await fetch(`${baseUrl()}/orders`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Alpaca order error: ${res.status} ${text}`);
    }
    const data = await res.json();
    return this.mapOrder(data);
  }

  async getOrder(orderId: string): Promise<AlpacaOrder> {
    const res = await fetch(`${baseUrl()}/orders/${orderId}`, { headers: headers() });
    if (!res.ok) throw new Error(`Alpaca getOrder error: ${res.status}`);
    const data = await res.json();
    return this.mapOrder(data);
  }

  async cancelOrder(orderId: string): Promise<void> {
    const res = await fetch(`${baseUrl()}/orders/${orderId}`, { method: 'DELETE', headers: headers() });
    if (!res.ok) throw new Error(`Alpaca cancel error: ${res.status}`);
  }

  async closePosition(symbol: string): Promise<void> {
    const res = await fetch(`${baseUrl()}/positions/${symbol}`, { method: 'DELETE', headers: headers() });
    if (!res.ok) throw new Error(`Alpaca closePosition error: ${res.status}`);
  }

  async closeAllPositions(): Promise<void> {
    const res = await fetch(`${baseUrl()}/positions`, { method: 'DELETE', headers: headers() });
    if (!res.ok) throw new Error(`Alpaca closeAll error: ${res.status}`);
  }

  private mapOrder(data: Record<string, unknown>): AlpacaOrder {
    return {
      id: data.id as string,
      status: data.status as string,
      filledAvgPrice: data.filled_avg_price ? parseFloat(data.filled_avg_price as string) : null,
      filledQty: data.filled_qty ? parseFloat(data.filled_qty as string) : null,
    };
  }
}

export const alpacaOrderService = new AlpacaOrderService();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd oracle-web/server && npx vitest run src/__tests__/alpacaOrderService.test.ts`

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/alpacaOrderService.ts server/src/__tests__/alpacaOrderService.test.ts
git commit -m "feat: add AlpacaOrderService for paper trading"
```

---

### Task 3: Create TradeFilterService

**Files:**
- Create: `server/src/services/tradeFilterService.ts`
- Create: `server/src/__tests__/tradeFilterService.test.ts`

- [ ] **Step 1: Write failing tests for all 5 filter gates**

Create `server/src/__tests__/tradeFilterService.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    execution: {
      max_positions: 8,
      max_capital_pct: 0.5,
      max_daily_drawdown_pct: 0.05,
      max_risk_pct: 0.10,
      risk_per_trade: 100,
      red_candle_vol_mult: 1.5,
      momentum_gap_pct: 0.03,
    },
  },
}));

import { tradeFilterService, AccountState } from '../services/tradeFilterService.js';
import { TradeCandidate } from '../services/ruleEngineService.js';

function makeCandidate(overrides: Partial<TradeCandidate> & { suggestedEntry: number; suggestedStop: number }): TradeCandidate {
  return {
    symbol: 'TEST',
    score: 70,
    setup: 'momentum_continuation',
    rationale: [],
    oracleScore: 50,
    messageScore: 50,
    executionScore: 50,
    messageContext: { symbol: 'TEST', mentionCount: 0, convictionScore: 0, tagCounts: {}, latestMessages: [] },
    snapshot: {
      currentPrice: overrides.suggestedEntry,
      buyZonePrice: overrides.suggestedEntry,
      stopPrice: overrides.suggestedStop,
      sellZonePrice: (overrides as any).suggestedTarget ?? overrides.suggestedEntry * 1.5,
      profitDeltaPct: null,
      trend30m: 'up',
    },
    suggestedEntry: overrides.suggestedEntry,
    suggestedStop: overrides.suggestedStop,
    suggestedTarget: (overrides as any).suggestedTarget ?? overrides.suggestedEntry * 1.5,
    ...overrides,
  } as TradeCandidate;
}

function makeAccount(overrides: Partial<AccountState> = {}): AccountState {
  return {
    cash: 10000,
    portfolioValue: 10000,
    startOfDayEquity: 10000,
    openPositionCount: 0,
    deployedCapital: 0,
    dailyRealizedPnl: 0,
    dailyUnrealizedPnl: 0,
    ...overrides,
  };
}

describe('TradeFilterService', () => {
  describe('daily drawdown breaker', () => {
    it('rejects when daily loss exceeds 5% of starting equity', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.00, suggestedStop: 0.95 });
      const account = makeAccount({ dailyRealizedPnl: -400, dailyUnrealizedPnl: -150 });
      const result = tradeFilterService.filterCandidate(candidate, account);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('drawdown');
    });

    it('passes when daily loss is within limit', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.00, suggestedStop: 0.95 });
      const account = makeAccount({ dailyRealizedPnl: -100, dailyUnrealizedPnl: -50 });
      const result = tradeFilterService.filterCandidate(candidate, account);
      expect(result.passed).toBe(true);
    });
  });

  describe('max positions', () => {
    it('rejects when at max positions', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.00, suggestedStop: 0.95 });
      const account = makeAccount({ openPositionCount: 8 });
      const result = tradeFilterService.filterCandidate(candidate, account);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('max_positions');
    });
  });

  describe('capital deployment cap', () => {
    it('rejects when deployed capital exceeds 50%', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.00, suggestedStop: 0.95 });
      const account = makeAccount({ deployedCapital: 5100 });
      const result = tradeFilterService.filterCandidate(candidate, account);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('capital');
    });
  });

  describe('max risk percentage', () => {
    it('rejects when stop is >10% from entry (HUBC-like)', () => {
      const candidate = makeCandidate({ suggestedEntry: 0.226, suggestedStop: 0.11 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount());
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('risk_pct');
    });

    it('passes when stop is within 10%', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.00, suggestedStop: 0.95 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount());
      expect(result.passed).toBe(true);
    });
  });

  describe('position sizing', () => {
    it('calculates shares from risk budget', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.00, suggestedStop: 0.95 });
      const size = tradeFilterService.calculatePositionSize(candidate, makeAccount());
      // risk_per_trade=100, riskPerShare=0.05, shares=floor(100/0.05)=2000
      expect(size.shares).toBe(2000);
      expect(size.costBasis).toBe(2000);
    });

    it('returns 0 shares if cost would breach capital cap', () => {
      const candidate = makeCandidate({ suggestedEntry: 100.00, suggestedStop: 95.00 });
      // risk_per_trade=100, riskPerShare=5, shares=floor(100/5)=20, cost=2000
      // account has 10000 cash, 50% cap = 5000, already deployed 4500
      const account = makeAccount({ deployedCapital: 4500 });
      const size = tradeFilterService.calculatePositionSize(candidate, account);
      expect(size.shares).toBe(0);
    });

    it('returns 0 shares if risk per share is zero', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.00, suggestedStop: 1.00 });
      const size = tradeFilterService.calculatePositionSize(candidate, makeAccount());
      expect(size.shares).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd oracle-web/server && npx vitest run src/__tests__/tradeFilterService.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement TradeFilterService**

Create `server/src/services/tradeFilterService.ts`:

```typescript
import { config } from '../config.js';
import { TradeCandidate } from './ruleEngineService.js';

export interface AccountState {
  cash: number;
  portfolioValue: number;
  startOfDayEquity: number;
  openPositionCount: number;
  deployedCapital: number;
  dailyRealizedPnl: number;
  dailyUnrealizedPnl: number;
}

export interface FilterResult {
  passed: boolean;
  reason: string | null;
}

export interface PositionSize {
  shares: number;
  costBasis: number;
}

class TradeFilterService {
  filterCandidate(candidate: TradeCandidate, account: AccountState): FilterResult {
    const exec = config.execution;

    const dailyLoss = account.dailyRealizedPnl + account.dailyUnrealizedPnl;
    const drawdownPct = account.startOfDayEquity > 0
      ? Math.abs(Math.min(0, dailyLoss)) / account.startOfDayEquity
      : 0;
    if (drawdownPct >= exec.max_daily_drawdown_pct) {
      return { passed: false, reason: `drawdown ${(drawdownPct * 100).toFixed(1)}% exceeds max ${(exec.max_daily_drawdown_pct * 100).toFixed(1)}%` };
    }

    if (account.openPositionCount >= exec.max_positions) {
      return { passed: false, reason: `max_positions ${exec.max_positions} reached` };
    }

    const capitalPct = account.cash > 0 ? account.deployedCapital / account.cash : 1;
    if (capitalPct >= exec.max_capital_pct) {
      return { passed: false, reason: `capital deployed ${(capitalPct * 100).toFixed(1)}% exceeds max ${(exec.max_capital_pct * 100).toFixed(1)}%` };
    }

    const entry = candidate.suggestedEntry;
    const stop = candidate.suggestedStop;
    if (entry > 0 && stop > 0) {
      const riskPct = (entry - stop) / entry;
      if (riskPct > exec.max_risk_pct) {
        return { passed: false, reason: `risk_pct ${(riskPct * 100).toFixed(1)}% exceeds max ${(exec.max_risk_pct * 100).toFixed(1)}%` };
      }
    }

    return { passed: true, reason: null };
  }

  calculatePositionSize(candidate: TradeCandidate, account: AccountState): PositionSize {
    const exec = config.execution;
    const entry = candidate.suggestedEntry;
    const stop = candidate.suggestedStop;
    const riskPerShare = entry - stop;

    if (riskPerShare <= 0) {
      return { shares: 0, costBasis: 0 };
    }

    const shares = Math.floor(exec.risk_per_trade / riskPerShare);
    const costBasis = shares * entry;

    const maxDeployable = account.cash * exec.max_capital_pct - account.deployedCapital;
    if (costBasis > maxDeployable || shares < 1) {
      return { shares: 0, costBasis: 0 };
    }

    return { shares, costBasis };
  }
}

export const tradeFilterService = new TradeFilterService();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd oracle-web/server && npx vitest run src/__tests__/tradeFilterService.test.ts`

Expected: All 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/tradeFilterService.ts server/src/__tests__/tradeFilterService.test.ts
git commit -m "feat: add TradeFilterService with risk, capital, and drawdown gates"
```

---

### Task 4: Add `lastPrice` to StockState

**Files:**
- Modify: `server/src/websocket/priceSocket.ts`

The momentum gap filter (Task 5) needs `lastPrice` on StockState. It's already on `WatchlistItem` from the Playwright scraper but not mapped through.

- [ ] **Step 1: Add lastPrice to StockState interface**

In `priceSocket.ts`, add `lastPrice` to the `StockState` interface after `gapPercent`:

```typescript
  lastPrice?: number | null;
```

- [ ] **Step 2: Map lastPrice in createStockState**

In the `createStockState` method, add the mapping:

```typescript
      lastPrice: item.lastPrice ?? null,
```

This goes after the `gapPercent` mapping line.

- [ ] **Step 3: Commit**

```bash
git add server/src/websocket/priceSocket.ts
git commit -m "feat: map lastPrice from WatchlistItem to StockState for gap filter"
```

---

### Task 5: Update RuleEngine — tighten filters, expose suggested levels

**Files:**
- Modify: `server/src/services/ruleEngineService.ts`

**Prerequisite:** Task 4 must be done first (adds `lastPrice` to `StockState`).

- [ ] **Step 1: Add suggestedEntry, suggestedStop, suggestedTarget to TradeCandidate**

In `ruleEngineService.ts`, update the `TradeCandidate` interface to add three new fields after `snapshot`:

```typescript
export interface TradeCandidate {
  symbol: string;
  score: number;
  setup: CandidateSetup;
  rationale: string[];
  oracleScore: number;
  messageScore: number;
  executionScore: number;
  messageContext: SymbolMessageContext;
  snapshot: {
    currentPrice: number | null;
    buyZonePrice: number | null | undefined;
    stopPrice: number | null | undefined;
    sellZonePrice: number | null | undefined;
    profitDeltaPct: number | null | undefined;
    trend30m: StockState['trend30m'];
  };
  suggestedEntry: number;
  suggestedStop: number;
  suggestedTarget: number;
}
```

- [ ] **Step 2: Populate suggested levels in evaluateStock**

In `evaluateStock()`, after building the `snapshot` object (around line 82-99), derive the suggested levels and include them in the return:

```typescript
    const suggestedEntry = stock.currentPrice ?? stock.buyZonePrice ?? 0;
    const suggestedStop = redCandleSignal.matched && redCandleSignal.stop
      ? redCandleSignal.stop
      : (stock.stopPrice ?? 0);
    const suggestedTarget = stock.sellZonePrice ?? 0;

    return {
      symbol: stock.symbol,
      score: Math.round(weighted * 100) / 100,
      setup,
      rationale,
      oracleScore,
      messageScore,
      executionScore,
      messageContext,
      snapshot: {
        currentPrice: stock.currentPrice,
        buyZonePrice: stock.buyZonePrice,
        stopPrice: stock.stopPrice,
        sellZonePrice: stock.sellZonePrice,
        profitDeltaPct: stock.profitDeltaPct,
        trend30m: stock.trend30m,
      },
      suggestedEntry,
      suggestedStop,
      suggestedTarget,
    };
```

- [ ] **Step 3: Tighten Red Candle volume gate**

In `detectRedCandleTheory()`, change the volume confirmation line (around line 225):

Replace:
```typescript
      const volumeConfirm = latest.volume >= avgRecentVolume * 1.15;
```

With:
```typescript
      const volumeConfirm = latest.volume >= avgRecentVolume * config.execution.red_candle_vol_mult;
```

Add the import at the top of the file:
```typescript
import { config } from '../config.js';
```

- [ ] **Step 4: Add momentum gap filter in pickSetup**

In `pickSetup()`, update the momentum_continuation fallback (around line 190) to check gap:

Replace:
```typescript
    if (stock.buyZonePrice !== null && stock.stopPrice !== null && stock.sellZonePrice !== null) {
      // Fallback candidate when structure is good but message tags are sparse.
      return 'momentum_continuation';
    }
```

With:
```typescript
    if (stock.buyZonePrice !== null && stock.stopPrice !== null && stock.sellZonePrice !== null) {
      const lastPrice = stock.lastPrice;
      const currentPrice = stock.currentPrice;
      if (lastPrice && lastPrice > 0 && currentPrice !== null) {
        const gapPct = (currentPrice - lastPrice) / lastPrice;
        if (gapPct < config.execution.momentum_gap_pct) {
          return null;
        }
      }
      return 'momentum_continuation';
    }
```

- [ ] **Step 5: Also gate the explicit momentum check (lines 169-175)**

Replace:
```typescript
    if (
      (hasTag('gap_and_go') || hasTag('orb_break')) &&
      stock.buyZonePrice !== null &&
      stock.stopPrice !== null &&
      stock.trend30m !== 'down'
    ) {
      return 'momentum_continuation';
    }
```

With:
```typescript
    if (
      (hasTag('gap_and_go') || hasTag('orb_break')) &&
      stock.buyZonePrice !== null &&
      stock.stopPrice !== null &&
      stock.trend30m !== 'down'
    ) {
      const lastPrice = stock.lastPrice;
      const currentPrice = stock.currentPrice;
      const hasGap = lastPrice && lastPrice > 0 && currentPrice !== null
        ? (currentPrice - lastPrice) / lastPrice >= config.execution.momentum_gap_pct
        : true;
      if (hasGap) {
        return 'momentum_continuation';
      }
    }
```

- [ ] **Step 6: Run existing tests to verify nothing broke**

Run: `cd oracle-web/server && npx vitest run`

Expected: All existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/ruleEngineService.ts
git commit -m "feat: tighten red candle volume gate, add momentum gap filter, expose suggested levels"
```

---

### Task 6: Create ExecutionService

**Files:**
- Create: `server/src/services/executionService.ts`
- Create: `server/src/__tests__/executionService.test.ts`

- [ ] **Step 1: Write failing tests for ExecutionService**

Create `server/src/__tests__/executionService.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    execution: {
      enabled: true,
      paper: true,
      risk_per_trade: 100,
      max_positions: 8,
      max_capital_pct: 0.5,
      max_daily_drawdown_pct: 0.05,
      max_risk_pct: 0.10,
      red_candle_vol_mult: 1.5,
      momentum_gap_pct: 0.03,
      trailing_breakeven_r: 1.0,
      trailing_start_r: 2.0,
      trailing_distance_r: 1.0,
      eod_flatten_time: '15:50',
    },
    market_hours: { timezone: 'America/New_York' },
  },
}));

const mockOrderService = {
  getAccount: vi.fn(),
  getPositions: vi.fn(),
  submitOrder: vi.fn(),
  getOrder: vi.fn(),
  cancelOrder: vi.fn(),
  closePosition: vi.fn(),
  closeAllPositions: vi.fn(),
};

vi.mock('../services/alpacaOrderService.js', () => ({
  alpacaOrderService: mockOrderService,
}));

vi.mock('../services/tradeFilterService.js', () => ({
  tradeFilterService: {
    filterCandidate: vi.fn().mockReturnValue({ passed: true, reason: null }),
    calculatePositionSize: vi.fn().mockReturnValue({ shares: 100, costBasis: 50 }),
  },
}));

import { ExecutionService } from '../services/executionService.js';
import { tradeFilterService } from '../services/tradeFilterService.js';
import type { TradeCandidate } from '../services/ruleEngineService.js';
import type { StockState } from '../websocket/priceSocket.js';

function makeCandidate(symbol: string, entry: number, stop: number, target: number): TradeCandidate {
  return {
    symbol,
    score: 70,
    setup: 'momentum_continuation',
    rationale: [],
    oracleScore: 50,
    messageScore: 50,
    executionScore: 50,
    messageContext: { symbol, mentionCount: 0, convictionScore: 0, tagCounts: {}, latestMessages: [] },
    snapshot: { currentPrice: entry, buyZonePrice: entry, stopPrice: stop, sellZonePrice: target, profitDeltaPct: null, trend30m: 'up' },
    suggestedEntry: entry,
    suggestedStop: stop,
    suggestedTarget: target,
  } as TradeCandidate;
}

function makeStockState(symbol: string, price: number): StockState {
  return { symbol, currentPrice: price } as StockState;
}

describe('ExecutionService', () => {
  let service: ExecutionService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOrderService.getAccount.mockResolvedValue({ cash: 10000, portfolioValue: 10000, buyingPower: 10000 });
    mockOrderService.getPositions.mockResolvedValue([]);
    mockOrderService.submitOrder.mockResolvedValue({ id: 'order-1', status: 'accepted', filledAvgPrice: null, filledQty: null });
    service = new ExecutionService();
  });

  describe('entry', () => {
    it('places an order for a passing candidate', async () => {
      const candidates = [makeCandidate('AGAE', 0.50, 0.30, 0.94)];
      const stocks = [makeStockState('AGAE', 0.50)];

      await service.onPriceCycle(candidates, stocks);

      expect(mockOrderService.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: 'AGAE', side: 'buy', qty: 100 }),
      );
      expect(service.getActiveTrades()).toHaveLength(1);
      expect(service.getActiveTrades()[0].symbol).toBe('AGAE');
    });

    it('skips candidate that fails filter', async () => {
      vi.mocked(tradeFilterService.filterCandidate).mockReturnValueOnce({ passed: false, reason: 'risk too high' });
      const candidates = [makeCandidate('HUBC', 0.226, 0.11, 0.37)];
      await service.onPriceCycle(candidates, [makeStockState('HUBC', 0.226)]);
      expect(mockOrderService.submitOrder).not.toHaveBeenCalled();
    });

    it('does not duplicate entry for symbol already in active trades', async () => {
      const candidates = [makeCandidate('AGAE', 0.50, 0.30, 0.94)];
      const stocks = [makeStockState('AGAE', 0.50)];
      await service.onPriceCycle(candidates, stocks);
      await service.onPriceCycle(candidates, stocks);
      expect(mockOrderService.submitOrder).toHaveBeenCalledTimes(1);
    });
  });

  describe('trailing stop', () => {
    it('moves stop to breakeven at 1R', async () => {
      const candidates = [makeCandidate('AGAE', 0.50, 0.40, 0.94)];
      const stocks = [makeStockState('AGAE', 0.50)];
      await service.onPriceCycle(candidates, stocks);

      // Simulate fill
      mockOrderService.getOrder.mockResolvedValue({ id: 'order-1', status: 'filled', filledAvgPrice: 0.50, filledQty: 100 });
      await service.onPriceCycle([], [makeStockState('AGAE', 0.50)]);

      // Price moves to 1R (0.50 + 0.10 = 0.60)
      await service.onPriceCycle([], [makeStockState('AGAE', 0.60)]);

      const trade = service.getActiveTrades().find(t => t.symbol === 'AGAE');
      expect(trade?.currentStop).toBe(0.50);
      expect(trade?.trailingState).toBe('breakeven');
    });

    it('trails at 1R behind after 2R', async () => {
      const candidates = [makeCandidate('AGAE', 0.50, 0.40, 0.94)];
      const stocks = [makeStockState('AGAE', 0.50)];
      await service.onPriceCycle(candidates, stocks);

      mockOrderService.getOrder.mockResolvedValue({ id: 'order-1', status: 'filled', filledAvgPrice: 0.50, filledQty: 100 });
      await service.onPriceCycle([], [makeStockState('AGAE', 0.50)]);

      // Price at 2R (0.50 + 0.20 = 0.70)
      await service.onPriceCycle([], [makeStockState('AGAE', 0.70)]);

      const trade = service.getActiveTrades().find(t => t.symbol === 'AGAE');
      // currentStop = 0.70 - 1R(0.10) = 0.60
      expect(trade?.currentStop).toBe(0.60);
      expect(trade?.trailingState).toBe('trailing');
    });
  });

  describe('exit', () => {
    it('exits when price hits stop', async () => {
      const candidates = [makeCandidate('AGAE', 0.50, 0.40, 0.94)];
      await service.onPriceCycle(candidates, [makeStockState('AGAE', 0.50)]);

      mockOrderService.getOrder.mockResolvedValue({ id: 'order-1', status: 'filled', filledAvgPrice: 0.50, filledQty: 100 });
      await service.onPriceCycle([], [makeStockState('AGAE', 0.50)]);

      // Price drops to stop
      await service.onPriceCycle([], [makeStockState('AGAE', 0.39)]);

      expect(mockOrderService.closePosition).toHaveBeenCalledWith('AGAE');
      expect(service.getActiveTrades()).toHaveLength(0);
      expect(service.getLedger()).toHaveLength(1);
      expect(service.getLedger()[0].exitReason).toBe('stop');
    });
  });

  describe('circuit breaker', () => {
    it('blocks new entries after exceeding daily drawdown', async () => {
      vi.mocked(tradeFilterService.filterCandidate).mockReturnValue({ passed: false, reason: 'drawdown exceeded' });
      const candidates = [makeCandidate('TEST', 1.00, 0.95, 1.50)];
      await service.onPriceCycle(candidates, [makeStockState('TEST', 1.00)]);
      expect(mockOrderService.submitOrder).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd oracle-web/server && npx vitest run src/__tests__/executionService.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement ExecutionService**

Create `server/src/services/executionService.ts`:

```typescript
import { config } from '../config.js';
import { alpacaOrderService } from './alpacaOrderService.js';
import { tradeFilterService, AccountState } from './tradeFilterService.js';
import { TradeCandidate, CandidateSetup } from './ruleEngineService.js';
import { StockState } from '../websocket/priceSocket.js';

export interface ActiveTrade {
  symbol: string;
  strategy: CandidateSetup;
  entryPrice: number;
  entryTime: Date;
  shares: number;
  initialStop: number;
  currentStop: number;
  target: number;
  riskPerShare: number;
  orderId: string;
  status: 'pending' | 'filled' | 'exiting';
  trailingState: 'initial' | 'breakeven' | 'trailing';
  pendingSince: Date;
}

export interface TradeLedgerEntry {
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

const PENDING_TIMEOUT_MS = 30 * 60 * 1000;

export class ExecutionService {
  private activeTrades: ActiveTrade[] = [];
  private ledger: TradeLedgerEntry[] = [];
  private startOfDayEquity: number | null = null;
  private enabled = config.execution.enabled;

  getActiveTrades(): ActiveTrade[] {
    return [...this.activeTrades];
  }

  getLedger(): TradeLedgerEntry[] {
    return [...this.ledger];
  }

  getDailyPnl(): number {
    return this.ledger.reduce((sum, t) => sum + t.pnl, 0);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async onPriceCycle(candidates: TradeCandidate[], stocks: StockState[]): Promise<void> {
    if (!this.enabled) return;

    const account = await this.buildAccountState();

    await this.checkPendingOrders();
    await this.cancelStaleOrders();
    await this.manageFilled(stocks);
    await this.evaluateNewEntries(candidates, account);
  }

  async flattenAll(): Promise<void> {
    for (const trade of this.activeTrades) {
      await this.exitTrade(trade, trade.entryPrice, 'eod');
    }
    try {
      await alpacaOrderService.closeAllPositions();
    } catch {
      // best effort
    }
    this.activeTrades = [];
  }

  private async buildAccountState(): Promise<AccountState> {
    const account = await alpacaOrderService.getAccount();
    const positions = await alpacaOrderService.getPositions();

    if (this.startOfDayEquity === null) {
      this.startOfDayEquity = account.portfolioValue;
    }

    const deployedCapital = positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
    const unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPl, 0);

    return {
      cash: account.cash,
      portfolioValue: account.portfolioValue,
      startOfDayEquity: this.startOfDayEquity,
      openPositionCount: this.activeTrades.filter(t => t.status === 'filled').length,
      deployedCapital,
      dailyRealizedPnl: this.getDailyPnl(),
      dailyUnrealizedPnl: unrealizedPnl,
    };
  }

  private async evaluateNewEntries(candidates: TradeCandidate[], account: AccountState): Promise<void> {
    for (const candidate of candidates) {
      if (this.activeTrades.some(t => t.symbol === candidate.symbol)) continue;
      if (candidate.suggestedEntry <= 0 || candidate.suggestedStop <= 0) continue;

      const filterResult = tradeFilterService.filterCandidate(candidate, account);
      if (!filterResult.passed) continue;

      const size = tradeFilterService.calculatePositionSize(candidate, account);
      if (size.shares <= 0) continue;

      const orderType = candidate.setup === 'red_candle_theory' || candidate.setup === 'momentum_continuation'
        ? 'limit' as const
        : 'market' as const;

      try {
        const order = await alpacaOrderService.submitOrder({
          symbol: candidate.symbol,
          qty: size.shares,
          side: 'buy',
          type: orderType,
          limitPrice: orderType === 'limit' ? candidate.suggestedEntry : undefined,
        });

        this.activeTrades.push({
          symbol: candidate.symbol,
          strategy: candidate.setup,
          entryPrice: candidate.suggestedEntry,
          entryTime: new Date(),
          shares: size.shares,
          initialStop: candidate.suggestedStop,
          currentStop: candidate.suggestedStop,
          target: candidate.suggestedTarget,
          riskPerShare: candidate.suggestedEntry - candidate.suggestedStop,
          orderId: order.id,
          status: 'pending',
          trailingState: 'initial',
          pendingSince: new Date(),
        });

        account.openPositionCount++;
        account.deployedCapital += size.costBasis;
      } catch (err) {
        console.error(`Failed to submit order for ${candidate.symbol}:`, err);
      }
    }
  }

  private async checkPendingOrders(): Promise<void> {
    for (const trade of this.activeTrades) {
      if (trade.status !== 'pending') continue;
      try {
        const order = await alpacaOrderService.getOrder(trade.orderId);
        if (order.status === 'filled') {
          trade.status = 'filled';
          if (order.filledAvgPrice) trade.entryPrice = order.filledAvgPrice;
          if (order.filledQty) trade.shares = order.filledQty;
          trade.riskPerShare = trade.entryPrice - trade.initialStop;
        } else if (order.status === 'canceled' || order.status === 'expired' || order.status === 'rejected') {
          this.activeTrades = this.activeTrades.filter(t => t !== trade);
        }
      } catch {
        // will retry next cycle
      }
    }
  }

  private async cancelStaleOrders(): Promise<void> {
    const now = Date.now();
    for (const trade of [...this.activeTrades]) {
      if (trade.status === 'pending' && now - trade.pendingSince.getTime() > PENDING_TIMEOUT_MS) {
        try {
          await alpacaOrderService.cancelOrder(trade.orderId);
        } catch {
          // best effort
        }
        this.activeTrades = this.activeTrades.filter(t => t !== trade);
      }
    }
  }

  private async manageFilled(stocks: StockState[]): Promise<void> {
    const priceMap = new Map(stocks.map(s => [s.symbol, s.currentPrice]));

    for (const trade of [...this.activeTrades]) {
      if (trade.status !== 'filled') continue;

      const currentPrice = priceMap.get(trade.symbol);
      if (currentPrice === null || currentPrice === undefined) continue;

      // Check stop
      if (currentPrice <= trade.currentStop) {
        await this.exitTrade(trade, currentPrice, trade.trailingState !== 'initial' ? 'trailing_stop' : 'stop');
        continue;
      }

      // Check target
      if (currentPrice >= trade.target) {
        await this.exitTrade(trade, currentPrice, 'target');
        continue;
      }

      // Update trailing stop
      const rMultiple = trade.riskPerShare > 0
        ? (currentPrice - trade.entryPrice) / trade.riskPerShare
        : 0;

      const exec = config.execution;
      if (rMultiple >= exec.trailing_start_r) {
        const newStop = currentPrice - exec.trailing_distance_r * trade.riskPerShare;
        trade.currentStop = Math.max(trade.currentStop, newStop);
        trade.trailingState = 'trailing';
      } else if (rMultiple >= exec.trailing_breakeven_r) {
        trade.currentStop = Math.max(trade.currentStop, trade.entryPrice);
        trade.trailingState = 'breakeven';
      }
    }
  }

  private async exitTrade(
    trade: ActiveTrade,
    exitPrice: number,
    reason: TradeLedgerEntry['exitReason']
  ): Promise<void> {
    trade.status = 'exiting';
    try {
      await alpacaOrderService.closePosition(trade.symbol);
    } catch (err) {
      console.error(`Failed to close position ${trade.symbol}:`, err);
    }

    const pnl = (exitPrice - trade.entryPrice) * trade.shares;
    const pnlPct = trade.entryPrice > 0 ? (exitPrice - trade.entryPrice) / trade.entryPrice * 100 : 0;
    const rMultiple = trade.riskPerShare > 0 ? (exitPrice - trade.entryPrice) / trade.riskPerShare : 0;

    this.ledger.push({
      symbol: trade.symbol,
      strategy: trade.strategy,
      entryPrice: trade.entryPrice,
      entryTime: trade.entryTime,
      exitPrice,
      exitTime: new Date(),
      shares: trade.shares,
      pnl,
      pnlPct,
      rMultiple,
      exitReason: reason,
    });

    this.activeTrades = this.activeTrades.filter(t => t !== trade);
  }
}

export const executionService = new ExecutionService();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd oracle-web/server && npx vitest run src/__tests__/executionService.test.ts`

Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/executionService.ts server/src/__tests__/executionService.test.ts
git commit -m "feat: add ExecutionService with trailing stops and trade lifecycle"
```

---

### Task 7: Wire execution into price polling loop

**Files:**
- Modify: `server/src/websocket/priceSocket.ts`

- [ ] **Step 1: Import executionService and add trade_update message type**

At the top of `priceSocket.ts`, add the import:

```typescript
import { executionService, ActiveTrade } from '../services/executionService.js';
```

Add the new message type to the `WebSocketMessage` union (after the `setup_alert` type):

```typescript
  | { type: 'trade_update'; data: { active: ActiveTrade[]; dailyPnl: number; circuitBreakerActive: boolean } };
```

- [ ] **Step 2: Call executionService in fetchPrices**

In `fetchPrices()`, after the existing setup_alert broadcast block (around line 343), add:

```typescript
    // Run execution engine
    if (config.execution.enabled) {
      try {
        await executionService.onPriceCycle(candidates, Array.from(this.stockStates.values()));
        this.broadcast({
          type: 'trade_update',
          data: {
            active: executionService.getActiveTrades(),
            dailyPnl: executionService.getDailyPnl(),
            circuitBreakerActive: false,
          },
        });
      } catch (err) {
        console.error('Execution cycle error:', err);
      }
    }
```

Note: the `candidates` variable is already defined in scope from the setup_alert block above it. Move the `candidates` declaration before the setup_alert block so it's available to both:

Replace:
```typescript
    // Broadcast setup alerts for high-quality setups
    try {
      const candidates = await ruleEngineService.getRankedCandidates(Array.from(this.stockStates.values()), 20);
```

With:
```typescript
    // Get ranked candidates for alerts and execution
    let candidates: Awaited<ReturnType<typeof ruleEngineService.getRankedCandidates>> = [];
    try {
      candidates = await ruleEngineService.getRankedCandidates(Array.from(this.stockStates.values()), 20);
```

- [ ] **Step 3: Add EOD flatten check**

In `fetchPrices()`, before the execution block, add an EOD flatten check:

```typescript
    // EOD flatten check
    if (config.execution.enabled) {
      const { toZonedTime } = await import('date-fns-tz');
      const now = toZonedTime(new Date(), config.market_hours.timezone);
      const [flatH, flatM] = config.execution.eod_flatten_time.split(':').map(Number);
      const flatMinutes = flatH * 60 + flatM;
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      if (nowMinutes >= flatMinutes && executionService.getActiveTrades().length > 0) {
        console.log('EOD flatten triggered');
        await executionService.flattenAll();
      }
    }
```

- [ ] **Step 4: Verify typecheck passes**

Run: `cd oracle-web/server && npx tsc --noEmit 2>&1 | grep -v "tickerBotService.ts"`

Expected: No new errors (only the pre-existing Playwright type-compat warnings).

- [ ] **Step 5: Commit**

```bash
git add server/src/websocket/priceSocket.ts
git commit -m "feat: wire ExecutionService into price polling loop with EOD flatten"
```

---

### Task 8: Add API endpoints

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Import executionService**

At the top of `index.ts`, add:

```typescript
import { executionService } from './services/executionService.js';
```

- [ ] **Step 2: Add /api/trades endpoint**

After the existing `/api/trade-candidates` route, add:

```typescript
app.get('/api/trades', (_req, res) => {
  res.json({
    active: executionService.getActiveTrades(),
    closed: executionService.getLedger(),
    dailyPnl: executionService.getDailyPnl(),
  });
});
```

- [ ] **Step 3: Add /api/execution/status endpoint**

```typescript
app.get('/api/execution/status', async (_req, res) => {
  try {
    const { alpacaOrderService } = await import('./services/alpacaOrderService.js');
    const account = await alpacaOrderService.getAccount();
    res.json({
      enabled: executionService.isEnabled(),
      paper: config.execution.paper,
      openPositions: executionService.getActiveTrades().length,
      maxPositions: config.execution.max_positions,
      deployedCapital: account.portfolioValue - account.cash,
      availableCash: account.cash,
      dailyPnl: executionService.getDailyPnl(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get execution status' });
  }
});
```

- [ ] **Step 4: Add /api/execution/toggle endpoint**

```typescript
app.post('/api/execution/toggle', botRateLimit, (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }
  executionService.setEnabled(enabled);
  res.json({ enabled: executionService.isEnabled() });
});
```

- [ ] **Step 5: Add /api/execution/flatten endpoint**

```typescript
app.post('/api/execution/flatten', botRateLimit, async (_req, res) => {
  try {
    await executionService.flattenAll();
    res.json({ message: 'All positions flattened', trades: executionService.getLedger().length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to flatten' });
  }
});
```

- [ ] **Step 6: Verify typecheck**

Run: `cd oracle-web/server && npx tsc --noEmit 2>&1 | grep -v "tickerBotService.ts"`

Expected: No new errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/index.ts
git commit -m "feat: add /api/trades, /api/execution/status, toggle, and flatten endpoints"
```

---

### Task 9: Run all tests and verify

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `cd oracle-web/server && npx vitest run`

Expected: All tests pass — alpacaOrderService (7), tradeFilterService (8), executionService (6), plus existing indicatorService and messageService tests.

- [ ] **Step 2: Run typecheck**

Run: `cd oracle-web/server && npx tsc --noEmit`

Expected: Only pre-existing Playwright type-compat warnings.

- [ ] **Step 3: Smoke test — start server and hit endpoints**

Run: `cd oracle-web/server && timeout 10 npx tsx src/index.ts` (or start server and curl):

```bash
curl -s http://localhost:3001/api/execution/status
curl -s http://localhost:3001/api/trades
curl -s -X POST -H 'Content-Type: application/json' -d '{"enabled":false}' http://localhost:3001/api/execution/toggle
```

Expected: Valid JSON responses, no crashes.

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address test/typecheck issues from integration"
```

---

### Task 10: Push branch and open PR

**Files:** None

- [ ] **Step 1: Create branch, push, and create PR**

```bash
git checkout -b add-auto-execution
git push -u origin add-auto-execution
gh pr create --title "Add auto-execution engine with paper trading" --body "$(cat <<'EOF'
## Summary
- Adds paper-trading auto-execution via Alpaca Trading API
- Risk-based position sizing ($100 risk/trade default, configurable)
- Trailing stops: breakeven at 1R, trail 1R behind after 2R
- Pre-entry filters: 10% max risk cap, 50% capital deployment limit, 5% daily drawdown breaker
- Red Candle volume gate tightened to 1.5x, momentum gap threshold at 3%
- EOD flatten at 3:50 PM ET
- New endpoints: /api/trades, /api/execution/status, /api/execution/toggle, /api/execution/flatten

## Test plan
- [ ] `npx vitest run` — all unit tests pass
- [ ] `npx tsc --noEmit` — no new type errors
- [ ] Start server, verify /api/execution/status returns valid JSON
- [ ] Paper trade during market hours and review /api/trades output

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

