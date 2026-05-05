import { describe, it, expect } from 'vitest';
import { buildSymbolDetail, SymbolDetailInputs } from '../services/symbolDetailService.js';
import type { StockState } from '../websocket/priceSocket.js';
import type { ActiveTrade, TradeLedgerEntry, FilterRejection } from '../services/executionService.js';
import type { TradeCandidate } from '../services/ruleEngineService.js';
import type { ModeratorAlertSnapshot } from '../services/moderatorAlertService.js';
import type { FloatMapSnapshot } from '../services/floatMapService.js';
import type { MessageEvent, SymbolMessageContext } from '../services/messageService.js';
import type { BrokerPosition } from '../types/broker.js';

const BASE_STOCK: StockState = {
  symbol: 'LOCL',
  targetPrice: 1.25,
  resistance: 1.5,
  currentPrice: 1.1,
  change: 0.05,
  changePercent: 4.7,
  trend30m: 'up',
  inTargetRange: false,
  alerted: false,
  source: 'oracle',
  lastUpdate: '2026-04-21T14:00:00Z',
  signal: null,
  boxTop: null,
  boxBottom: null,
  signalTimestamp: null,
  stopPrice: 0.95,
  buyZonePrice: 1.05,
  sellZonePrice: 1.35,
};

function emptyContext(symbol: string): SymbolMessageContext {
  return { symbol, mentionCount: 0, lastMentionAt: null, tagCounts: {}, convictionScore: 0 };
}

function emptyModerator(): ModeratorAlertSnapshot {
  return { fetchedAt: null, posts: [], error: null };
}

function emptyFloatMap(): FloatMapSnapshot {
  return { fetchedAt: null, entries: [], error: null };
}

function baseInputs(symbol: string, overrides: Partial<SymbolDetailInputs> = {}): SymbolDetailInputs {
  return {
    symbol,
    stocks: [],
    candidates: [],
    activeTrades: [],
    rejections: [],
    cooldowns: [],
    washSaleSymbols: [],
    floatMap: emptyFloatMap(),
    moderator: emptyModerator(),
    messageContext: emptyContext(symbol.toUpperCase()),
    recentMessages: [],
    ledger: [],
    positions: [],
    ...overrides,
  };
}

describe('buildSymbolDetail', () => {
  it('returns an empty skeleton for an unknown ticker', () => {
    const detail = buildSymbolDetail(baseInputs('abcd'));
    expect(detail.symbol).toBe('ABCD');
    expect(detail.inWatchlist).toBe(false);
    expect(detail.stockState).toBeNull();
    expect(detail.candidate).toBeNull();
    expect(detail.activeTrade).toBeNull();
    expect(detail.floatMap).toBeNull();
    expect(detail.moderator.primary).toBeNull();
    expect(detail.moderator.backups).toHaveLength(0);
    expect(detail.moderator.mentions).toHaveLength(0);
    expect(detail.closedTrades).toHaveLength(0);
  });

  it('hydrates watchlist, candidate, float map, cooldown, and wash-sale flags', () => {
    const candidate: TradeCandidate = {
      symbol: 'LOCL',
      score: 82,
      setup: 'red_candle_theory',
      rationale: ['red candle reclaim'],
      oracleScore: 70,
      messageScore: 40,
      executionScore: 60,
      messageContext: emptyContext('LOCL'),
      snapshot: {
        currentPrice: 1.1,
        buyZonePrice: 1.05,
        stopPrice: 0.95,
        sellZonePrice: 1.35,
        profitDeltaPct: 0.03,
        trend30m: 'up',
      },
      suggestedEntry: 1.08,
      suggestedStop: 0.96,
      suggestedTarget: 1.3,
    };
    const detail = buildSymbolDetail(
      baseInputs('LOCL', {
        stocks: [BASE_STOCK],
        candidates: [candidate],
        cooldowns: [{ symbol: 'LOCL', expiresAt: '2026-04-21T20:00:00Z' }],
        washSaleSymbols: ['LOCL'],
        floatMap: {
          fetchedAt: '2026-04-21T14:00:00Z',
          entries: [
            { symbol: 'LOCL', rotation: 2.1, last: 1.1, floatMillions: 8, nextOracleSupport: 1.0, nextOracleResistance: 1.4 },
          ],
          error: null,
        },
      }),
    );
    expect(detail.inWatchlist).toBe(true);
    expect(detail.stockState?.symbol).toBe('LOCL');
    expect(detail.candidate?.score).toBe(82);
    expect(detail.cooldownExpiresAt).toBe('2026-04-21T20:00:00Z');
    expect(detail.washSaleRisk).toBe(true);
    expect(detail.floatMap?.rotation).toBe(2.1);
  });

  it('attaches current price and computes R-multiple for an active trade', () => {
    const active: ActiveTrade = {
      symbol: 'LOCL',
      strategy: 'red_candle_theory',
      entryPrice: 1.0,
      entryTime: new Date('2026-04-21T13:45:00Z'),
      shares: 100,
      initialStop: 0.9,
      currentStop: 0.95,
      target: 1.3,
      riskPerShare: 0.1,
      orderId: 'ord-1',
      // Bracket-order leg handles. Phase 2 entries go through
      // submitBracketOrder so target+stop are managed server-side as OCO;
      // tests fix concrete ids so a future change that uses them still
      // type-checks against this fixture.
      targetOrderId: 'ord-1-target',
      stopOrderId: 'ord-1-stop',
      lastBrokerStop: 0.9,
      status: 'filled',
      trailingState: 'mfe_lock',
      maxFavorableR: 0.6,
      pendingSince: new Date('2026-04-21T13:45:00Z'),
      rationale: ['buy zone reclaim'],
    };
    const position: BrokerPosition = {
      symbol: 'LOCL',
      qty: 100,
      avgEntryPrice: 1.0,
      currentPrice: 1.12,
      marketValue: 112,
      unrealizedPl: 12,
    };
    const detail = buildSymbolDetail(
      baseInputs('LOCL', {
        stocks: [BASE_STOCK],
        activeTrades: [active],
        positions: [position],
      }),
    );
    expect(detail.activeTrade?.currentPrice).toBe(1.12);
    expect(detail.activeTrade?.unrealizedPl).toBe(12);
    expect(detail.activeTrade?.rMultiple).toBeCloseTo(1.2, 5);
    expect(detail.activeTrade?.trailingState).toBe('mfe_lock');
  });

  it('splits moderator posts into primary / backup / mention roles', () => {
    const moderator: ModeratorAlertSnapshot = {
      fetchedAt: '2026-04-21T13:00:00Z',
      error: null,
      posts: [
        {
          title: 'Daily Market Profits Alert: $LOCL',
          kind: 'alert',
          author: 'Tim Bohen',
          postedAt: '2026-04-21T13:00:00Z',
          body: '$LOCL\nSignal: $1.05\nRisk Zone: $0.95\nTarget: Mid to high $1s',
          signal: { symbol: 'LOCL', signal: 1.05, riskZone: 0.95, target: 'Mid to high $1s', targetFloor: 1 },
          backups: [],
          symbols: [],
        },
        {
          title: 'Backup Ideas 4-21-2026',
          kind: 'backups',
          author: 'Tim Bohen',
          postedAt: '2026-04-21T12:00:00Z',
          body: '$LOCL $1.05\n$ABCD $2.00',
          signal: null,
          backups: [
            { symbol: 'LOCL', price: 1.05, note: null },
            { symbol: 'ABCD', price: 2.0, note: null },
          ],
          symbols: [],
        },
        {
          title: 'Pre Market Prep 4-21-2026',
          kind: 'pre_market_prep',
          author: 'Tim Bohen',
          postedAt: '2026-04-21T10:00:00Z',
          body: 'We are watching $LOCL for a continuation setup today.',
          signal: null,
          backups: [],
          symbols: [],
        },
      ],
    };
    const detail = buildSymbolDetail(baseInputs('locl', { moderator }));
    expect(detail.moderator.primary?.signal).toBe(1.05);
    expect(detail.moderator.primaryPost?.title).toContain('Alert');
    expect(detail.moderator.backups).toHaveLength(1);
    expect(detail.moderator.backups[0].price).toBe(1.05);
    expect(detail.moderator.mentions).toHaveLength(3);
    const roles = detail.moderator.mentions.map((m) => m.role);
    expect(roles).toEqual(expect.arrayContaining(['primary', 'backup', 'mention']));
  });

  it('filters ledger entries and recent messages to the target symbol', () => {
    const ledger: TradeLedgerEntry[] = [
      {
        symbol: 'LOCL',
        strategy: 'red_candle_theory',
        entryPrice: 1.0,
        entryTime: new Date('2026-04-18T13:45:00Z'),
        exitPrice: 1.2,
        exitTime: new Date('2026-04-18T14:30:00Z'),
        shares: 100,
        riskPerShare: 0.1,
        pnl: 20,
        pnlPct: 0.2,
        rMultiple: 2,
        exitReason: 'target',
        exitDetail: 'hit target',
        rationale: [],
      },
      {
        symbol: 'OTHER',
        strategy: 'momentum_continuation',
        entryPrice: 2.0,
        entryTime: new Date('2026-04-18T13:45:00Z'),
        exitPrice: 1.9,
        exitTime: new Date('2026-04-18T14:30:00Z'),
        shares: 50,
        riskPerShare: 0.1,
        pnl: -5,
        pnlPct: -0.05,
        rMultiple: -1,
        exitReason: 'stop',
        exitDetail: 'hit stop',
        rationale: [],
      },
    ];
    const detail = buildSymbolDetail(
      baseInputs('LOCL', {
        ledger,
        recentMessages: [
          {
            id: '1',
            text: '$LOCL vwap reclaim',
            channel: 'chat',
            author: 'alice',
            timestamp: '2026-04-21T13:40:00Z',
            symbols: ['LOCL'],
            tags: ['vwap_reclaim'],
            confidence: 0.6,
          } as MessageEvent,
        ],
      }),
    );
    expect(detail.closedTrades).toHaveLength(1);
    expect(detail.closedTrades[0].symbol).toBe('LOCL');
    expect(detail.recentMessages).toHaveLength(1);
  });

  it('surfaces a current rejection with its reason', () => {
    const rejection: FilterRejection = {
      symbol: 'LOCL',
      reason: 'Already at daily drawdown cap',
      score: 75,
      setup: 'red_candle_theory',
      suggestedEntry: 1.05,
      suggestedStop: 0.95,
      suggestedTarget: 1.3,
      timestamp: new Date('2026-04-21T13:40:00Z'),
    };
    const detail = buildSymbolDetail(baseInputs('LOCL', { rejections: [rejection] }));
    expect(detail.rejection?.reason).toBe('Already at daily drawdown cap');
  });
});
