import { describe, it, expect } from 'vitest';
import { buildSignalsInbox, SignalsInputs } from '../services/signalsService.js';
import type { TradeCandidate } from '../services/ruleEngineService.js';
import type { ModeratorAlertSnapshot } from '../services/moderatorAlertService.js';
import type { MessageEvent } from '../services/messageService.js';

const NOW = new Date('2026-04-21T14:00:00Z').getTime();

function emptyContext(symbol: string) {
  return { symbol, mentionCount: 0, lastMentionAt: null, tagCounts: {}, convictionScore: 0 };
}

function candidate(symbol: string, score: number, overrides: Partial<TradeCandidate> = {}): TradeCandidate {
  return {
    symbol,
    score,
    setup: 'red_candle_theory',
    rationale: ['ok'],
    oracleScore: 60,
    messageScore: 20,
    executionScore: 40,
    messageContext: emptyContext(symbol),
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
    ...overrides,
  };
}

function emptyModerator(): ModeratorAlertSnapshot {
  return { fetchedAt: null, posts: [], error: null };
}

function baseInputs(overrides: Partial<SignalsInputs> = {}): SignalsInputs {
  return {
    candidates: [],
    moderator: emptyModerator(),
    recentMessages: [],
    now: NOW,
    ...overrides,
  };
}

describe('buildSignalsInbox', () => {
  it('returns empty list when no sources have input', () => {
    expect(buildSignalsInbox(baseInputs())).toHaveLength(0);
  });

  it('puts moderator primary signals above candidates', () => {
    const moderator: ModeratorAlertSnapshot = {
      fetchedAt: null,
      error: null,
      posts: [
        {
          title: 'Daily Market Profits Alert: $BBBB',
          kind: 'alert',
          author: 'Tim Bohen',
          postedAt: '2026-04-21T13:00:00Z',
          body: '$BBBB\nSignal: $2.00\nRisk Zone: $1.80\nTarget: $2.50',
          signal: { symbol: 'BBBB', signal: 2.0, riskZone: 1.8, target: '$2.50', targetFloor: 2.5 },
          backups: [],
        },
      ],
    };
    const items = buildSignalsInbox(baseInputs({ moderator, candidates: [candidate('AAAA', 95)] }));
    expect(items[0].kind).toBe('moderator_primary');
    expect(items[0].symbol).toBe('BBBB');
    expect(items[1].kind).toBe('candidate');
    expect(items[1].symbol).toBe('AAAA');
  });

  it('ranks candidates by score tier', () => {
    const items = buildSignalsInbox(
      baseInputs({
        candidates: [candidate('LOW', 40), candidate('HIGH', 85), candidate('MID', 70)],
      }),
    );
    expect(items.map((i) => i.symbol)).toEqual(['HIGH', 'MID', 'LOW']);
  });

  it('fan-outs moderator backup list to one item per backup', () => {
    const moderator: ModeratorAlertSnapshot = {
      fetchedAt: null,
      error: null,
      posts: [
        {
          title: 'Backup Ideas 4-21-2026',
          kind: 'backups',
          author: 'Tim Bohen',
          postedAt: '2026-04-21T12:00:00Z',
          body: '$AAAA $1.00\n$BBBB $2.00',
          signal: null,
          backups: [
            { symbol: 'AAAA', price: 1.0, note: null },
            { symbol: 'BBBB', price: 2.0, note: 'first reclaim' },
          ],
        },
      ],
    };
    const items = buildSignalsInbox(baseInputs({ moderator }));
    const backups = items.filter((i) => i.kind === 'moderator_backup');
    expect(backups).toHaveLength(2);
    expect(backups.map((i) => i.symbol).sort()).toEqual(['AAAA', 'BBBB']);
  });

  it('flags hot community symbols above the mention threshold', () => {
    const base = new Date(NOW - 10 * 60 * 1000).toISOString();
    const msgs: MessageEvent[] = [
      { id: '1', text: '$HOT vwap', channel: 'c', author: 'a', timestamp: base, symbols: ['HOT'], tags: ['vwap_reclaim'], confidence: 0.5 },
      { id: '2', text: '$HOT gap', channel: 'c', author: 'b', timestamp: base, symbols: ['HOT'], tags: ['gap_and_go'], confidence: 0.5 },
      { id: '3', text: '$HOT break', channel: 'c', author: 'c', timestamp: base, symbols: ['HOT'], tags: [], confidence: 0.3 },
      { id: '4', text: '$COLD', channel: 'c', author: 'a', timestamp: base, symbols: ['COLD'], tags: [], confidence: 0.1 },
    ];
    const items = buildSignalsInbox(baseInputs({ recentMessages: msgs }));
    const hot = items.filter((i) => i.kind === 'community_hot');
    expect(hot).toHaveLength(1);
    expect(hot[0].symbol).toBe('HOT');
    expect(hot[0].details.mentionCount).toBe(3);
    expect(hot[0].details.topTags).toContain('vwap_reclaim');
  });

  it('ignores community messages outside the lookback window', () => {
    const stale = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
    const msgs: MessageEvent[] = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      text: '$STALE',
      channel: 'c',
      author: 'a',
      timestamp: stale,
      symbols: ['STALE'],
      tags: [],
      confidence: 0.3,
    }));
    const items = buildSignalsInbox(baseInputs({ recentMessages: msgs }));
    expect(items).toHaveLength(0);
  });

  it('sorts moderator primaries by time when priorities tie', () => {
    const moderator: ModeratorAlertSnapshot = {
      fetchedAt: null,
      error: null,
      posts: [
        {
          title: 'Daily Market Profits Alert: $OLD',
          kind: 'alert',
          author: 'Tim Bohen',
          postedAt: '2026-04-21T10:00:00Z',
          body: '$OLD\nSignal: $1\nRisk Zone: $0.9\nTarget: $1.5',
          signal: { symbol: 'OLD', signal: 1, riskZone: 0.9, target: '$1.5', targetFloor: 1.5 },
          backups: [],
        },
        {
          title: 'Daily Market Profits Alert: $NEW',
          kind: 'alert',
          author: 'Tim Bohen',
          postedAt: '2026-04-21T13:30:00Z',
          body: '$NEW\nSignal: $2\nRisk Zone: $1.8\nTarget: $2.5',
          signal: { symbol: 'NEW', signal: 2, riskZone: 1.8, target: '$2.5', targetFloor: 2.5 },
          backups: [],
        },
      ],
    };
    const items = buildSignalsInbox(baseInputs({ moderator }));
    expect(items[0].symbol).toBe('NEW');
    expect(items[1].symbol).toBe('OLD');
  });
});
