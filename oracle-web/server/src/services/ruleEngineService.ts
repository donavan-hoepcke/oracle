import { formatInTimeZone } from 'date-fns-tz';
import { StockState } from '../websocket/priceSocket.js';
import { fetchAlpaca1MinBars } from './alpacaBarService.js';
import { Bar } from './indicatorService.js';
import { SymbolMessageContext, messageService, SetupTag } from './messageService.js';
import { config } from '../config.js';

export type CandidateSetup =
  | 'red_candle_theory'
  | 'momentum_continuation'
  | 'pullback_reclaim'
  | 'crowded_extension_watch'
  | 'orb_breakout';

export interface RedCandleSignal {
  matched: boolean;
  candleHigh: number | null;
  candleLow: number | null;
  entry: number | null;
  stop: number | null;
  rrToSellZone: number | null;
  details: string[];
}

export function emptyRedCandleSignal(): RedCandleSignal {
  return {
    matched: false,
    candleHigh: null,
    candleLow: null,
    entry: null,
    stop: null,
    rrToSellZone: null,
    details: [],
  };
}

export interface OrbSignal {
  matched: boolean;
  rangeHigh: number | null;
  rangeLow: number | null;
  entry: number | null;
  stop: number | null;
  rrToSellZone: number | null;
  details: string[];
}

export function emptyOrbSignal(): OrbSignal {
  return {
    matched: false,
    rangeHigh: null,
    rangeLow: null,
    entry: null,
    stop: null,
    rrToSellZone: null,
    details: [],
  };
}

export interface MomentumSignal {
  matched: boolean;
  pullbackHigh: number | null;
  pullbackLow: number | null;
  hod: number | null;
  sessionOpen: number | null;
  entry: number | null;
  stop: number | null;
  rrToSellZone: number | null;
  details: string[];
}

export function emptyMomentumSignal(): MomentumSignal {
  return {
    matched: false,
    pullbackHigh: null,
    pullbackLow: null,
    hod: null,
    sessionOpen: null,
    entry: null,
    stop: null,
    rrToSellZone: null,
    details: [],
  };
}

export function emptyMessageContext(symbol: string): SymbolMessageContext {
  return {
    symbol,
    mentionCount: 0,
    lastMentionAt: null,
    tagCounts: {},
    convictionScore: 0,
  };
}

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

/**
 * Pure ORB (Opening Range Breakout) signal computation. Takes a preloaded
 * 1m bar series and evaluates as of `now`: builds the 9:30–(9:30 +
 * orb_range_minutes) ET high/low, then looks at the bars after the range
 * (but at or before `now`) for a close above the range high with volume
 * confirmation. Returns matched=true when the breakout bar also satisfies
 * chase-distance and min-range-size guards.
 *
 * Factored out so offline tooling (historical replay) can feed in-memory
 * bars instead of hitting Alpaca for every symbol×minute.
 */
export function computeOrbSignal(stock: StockState, bars: Bar[], now: Date): OrbSignal {
  if (!config.execution.orb_enabled) return emptyOrbSignal();
  if (bars.length === 0) return emptyOrbSignal();

  const tz = config.market_hours.timezone;
  const rangeMin = config.execution.orb_range_minutes;
  const todayEt = formatInTimeZone(now, tz, 'yyyy-MM-dd');
  const rangeStartMin = 9 * 60 + 30;
  const rangeEndMin = rangeStartMin + rangeMin;
  const nowMs = now.getTime();

  const openingBars = bars.filter((bar) => {
    if (bar.timestamp.getTime() > nowMs) return false;
    const etDate = formatInTimeZone(bar.timestamp, tz, 'yyyy-MM-dd');
    if (etDate !== todayEt) return false;
    const [h, m] = formatInTimeZone(bar.timestamp, tz, 'HH:mm').split(':').map(Number);
    const minOfDay = h * 60 + m;
    return minOfDay >= rangeStartMin && minOfDay < rangeEndMin;
  });

  // Require at least half the range-window bars so a stray data gap in the
  // first couple minutes doesn't build a range out of a single candle.
  if (openingBars.length < Math.ceil(rangeMin / 2)) return emptyOrbSignal();

  const rangeHigh = Math.max(...openingBars.map((b) => b.high));
  const rangeLow = Math.min(...openingBars.map((b) => b.low));
  const avgRangeVol = openingBars.reduce((sum, b) => sum + b.volume, 0) / openingBars.length;

  const lastOpeningTs = openingBars[openingBars.length - 1].timestamp.getTime();
  const postBars = bars.filter(
    (b) => b.timestamp.getTime() > lastOpeningTs && b.timestamp.getTime() <= nowMs,
  );
  if (postBars.length === 0) {
    return {
      matched: false,
      rangeHigh,
      rangeLow,
      entry: rangeHigh,
      stop: rangeLow,
      rrToSellZone: null,
      details: [],
    };
  }

  const latest = postBars[postBars.length - 1];
  const breakAbove = latest.close > rangeHigh;
  const volumeConfirm = latest.volume >= avgRangeVol * config.execution.orb_volume_mult;
  const referencePrice = stock.currentPrice ?? latest.close;
  const chasePct = rangeHigh > 0 ? (referencePrice - rangeHigh) / rangeHigh : Infinity;
  const withinChase = chasePct <= config.execution.orb_max_chase_pct;
  const rangePct = rangeHigh > 0 ? (rangeHigh - rangeLow) / rangeHigh : 0;
  const rangeValid = rangeHigh > rangeLow && rangePct >= config.execution.orb_min_range_pct;

  const risk = rangeHigh - rangeLow;
  const reward =
    stock.sellZonePrice !== null && stock.sellZonePrice !== undefined
      ? stock.sellZonePrice - rangeHigh
      : null;
  const rrToSellZone = reward !== null && risk > 0 ? reward / risk : null;

  const matched = breakAbove && volumeConfirm && withinChase && rangeValid;
  if (!matched) {
    return {
      matched: false,
      rangeHigh,
      rangeLow,
      entry: rangeHigh,
      stop: rangeLow,
      rrToSellZone,
      details: [],
    };
  }

  const details = [
    `ORB-${rangeMin} breakout above ${rangeHigh.toFixed(3)}`,
    `Suggested stop ${rangeLow.toFixed(3)} (opening range low)`,
  ];
  if (typeof rrToSellZone === 'number') {
    details.push(`Estimated R:R to sell zone ${rrToSellZone.toFixed(2)}x`);
  }

  return {
    matched: true,
    rangeHigh,
    rangeLow,
    entry: rangeHigh,
    stop: rangeLow,
    rrToSellZone,
    details,
  };
}

/**
 * Pure momentum-continuation detector. Mirrors ORB's shape but fires later in
 * the session. Looks for: (1) a meaningful up-move from session open to a high
 * of day, (2) a pullback of ≥ momentum_min_pullback_pct off that HOD whose low
 * stays above the session open (higher-low structure), and (3) the latest bar
 * closing back above the pullback ceiling with volume ≥ the pullback-window
 * average × momentum_volume_mult. Entry is the pullback high, stop the pullback
 * low — so each trade risks the precise reclaim structure instead of Oracle's
 * wide default stop.
 */
export function computeMomentumSignal(stock: StockState, bars: Bar[], now: Date): MomentumSignal {
  if (!config.execution.momentum_enabled) return emptyMomentumSignal();
  if (bars.length === 0) return emptyMomentumSignal();

  const tz = config.market_hours.timezone;
  const todayEt = formatInTimeZone(now, tz, 'yyyy-MM-dd');
  const rangeStartMin = 9 * 60 + 30;
  const nowMs = now.getTime();

  const sessionBars = bars.filter((bar) => {
    if (bar.timestamp.getTime() > nowMs) return false;
    const etDate = formatInTimeZone(bar.timestamp, tz, 'yyyy-MM-dd');
    if (etDate !== todayEt) return false;
    const [h, m] = formatInTimeZone(bar.timestamp, tz, 'HH:mm').split(':').map(Number);
    return h * 60 + m >= rangeStartMin;
  });

  // Need at least ~15 min of session data to have a meaningful HOD→pullback
  // structure; before that ORB owns the entry pattern.
  if (sessionBars.length < 15) return emptyMomentumSignal();

  const sessionOpen = sessionBars[0].open;
  const latest = sessionBars[sessionBars.length - 1];

  let hod = -Infinity;
  let hodIdx = 0;
  for (let i = 0; i < sessionBars.length - 1; i++) {
    if (sessionBars[i].high > hod) {
      hod = sessionBars[i].high;
      hodIdx = i;
    }
  }
  if (!isFinite(hod) || sessionOpen <= 0) return emptyMomentumSignal();

  const moveFromOpen = (hod - sessionOpen) / sessionOpen;
  if (moveFromOpen < config.execution.momentum_min_move_pct) return emptyMomentumSignal();

  const postHod = sessionBars.slice(hodIdx + 1, -1);
  if (postHod.length < 2) return emptyMomentumSignal();

  const pullbackLow = Math.min(...postHod.map((b) => b.low));
  const pullbackHigh = Math.max(...postHod.map((b) => b.high));
  const pullbackDepth = hod > 0 ? (hod - pullbackLow) / hod : 0;

  if (pullbackDepth < config.execution.momentum_min_pullback_pct) return emptyMomentumSignal();
  // Higher-low structure: the dip must hold above the session open, otherwise
  // the "pullback" is really a trend break.
  if (pullbackLow <= sessionOpen) return emptyMomentumSignal();

  const risk = pullbackHigh - pullbackLow;
  const reward =
    stock.sellZonePrice !== null && stock.sellZonePrice !== undefined
      ? stock.sellZonePrice - pullbackHigh
      : null;
  const rrToSellZone = reward !== null && risk > 0 ? reward / risk : null;

  const breakAbove = latest.close > pullbackHigh;
  const avgPullbackVol = postHod.reduce((s, b) => s + b.volume, 0) / postHod.length;
  const volumeConfirm = latest.volume >= avgPullbackVol * config.execution.momentum_volume_mult;
  const referencePrice = stock.currentPrice ?? latest.close;
  const chasePct = pullbackHigh > 0 ? (referencePrice - pullbackHigh) / pullbackHigh : Infinity;
  const withinChase = chasePct <= config.execution.momentum_max_chase_pct;

  const matched = breakAbove && volumeConfirm && withinChase && risk > 0;
  if (!matched) {
    return {
      matched: false,
      pullbackHigh,
      pullbackLow,
      hod,
      sessionOpen,
      entry: pullbackHigh,
      stop: pullbackLow,
      rrToSellZone,
      details: [],
    };
  }

  const details = [
    `Momentum reclaim above ${pullbackHigh.toFixed(3)}`,
    `Session open ${sessionOpen.toFixed(3)}, HOD ${hod.toFixed(3)}, pullback low ${pullbackLow.toFixed(3)}`,
    `Move from open ${(moveFromOpen * 100).toFixed(1)}%, pullback depth ${(pullbackDepth * 100).toFixed(1)}%`,
    `Suggested stop ${pullbackLow.toFixed(3)} (pullback low)`,
  ];
  if (typeof rrToSellZone === 'number') {
    details.push(`Estimated R:R to sell zone ${rrToSellZone.toFixed(2)}x`);
  }

  return {
    matched: true,
    pullbackHigh,
    pullbackLow,
    hod,
    sessionOpen,
    entry: pullbackHigh,
    stop: pullbackLow,
    rrToSellZone,
    details,
  };
}

class RuleEngineService {
  async getRankedCandidates(stocks: StockState[], limit = 10): Promise<TradeCandidate[]> {
    const evaluated = await Promise.all(
      stocks.map(async (stock) => {
        const messageContext = messageService.getSymbolContext(stock.symbol);
        return this.evaluateStock(stock, messageContext);
      })
    );

    const candidates = evaluated.filter((candidate): candidate is TradeCandidate => candidate !== null);

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, Math.max(1, Math.min(limit, 100)));
  }

  private async evaluateStock(stock: StockState, messageContext: SymbolMessageContext): Promise<TradeCandidate | null> {
    const [redCandleSignal, orbSignal, momentumSignal] = await Promise.all([
      this.detectRedCandleTheory(stock),
      this.detectOrbBreakout(stock),
      this.detectMomentumContinuation(stock),
    ]);
    return this.scoreFromInputs(stock, messageContext, redCandleSignal, orbSignal, momentumSignal);
  }

  /**
   * Pure scoring path. Takes pre-resolved inputs (message context + red-candle
   * signal + ORB signal + momentum signal) and returns the candidate without
   * touching any I/O — exposed so offline tooling (historical replay, unit
   * tests) can feed synthesized inputs through the same scoring logic the
   * live bot uses.
   */
  scoreFromInputs(
    stock: StockState,
    messageContext: SymbolMessageContext,
    redCandleSignal: RedCandleSignal,
    orbSignal: OrbSignal = emptyOrbSignal(),
    momentumSignal: MomentumSignal = emptyMomentumSignal(),
  ): TradeCandidate | null {
    const oracleScore = this.scoreOracle(stock);
    const messageScore = Math.min(100, messageContext.convictionScore);
    const executionScore = this.scoreExecution(stock, redCandleSignal);

    let weighted = oracleScore * 0.45 + messageScore * 0.35 + executionScore * 0.2;
    if (redCandleSignal.matched) {
      weighted += 8;
    }
    if (orbSignal.matched) {
      weighted += 6;
    }
    if (momentumSignal.matched) {
      weighted += 6;
    }

    const setup = this.pickSetup(stock, messageContext.tagCounts, redCandleSignal, orbSignal, momentumSignal);
    if (!setup) {
      return null;
    }

    const rationale: string[] = [];
    if (stock.buyZonePrice) rationale.push(`Buy zone ${stock.buyZonePrice.toFixed(3)} available`);
    if (stock.stopPrice) rationale.push(`Stop reference ${stock.stopPrice.toFixed(3)}`);
    if (stock.sellZonePrice) rationale.push(`Sell zone ${stock.sellZonePrice.toFixed(3)} available`);
    if (typeof stock.profitDeltaPct === 'number') rationale.push(`Profit delta ${stock.profitDeltaPct.toFixed(2)}%`);
    if (stock.trend30m) rationale.push(`30m trend ${stock.trend30m}`);
    if (messageContext.mentionCount > 0) rationale.push(`${messageContext.mentionCount} recent mentions in chat`);
    if (redCandleSignal.matched) {
      rationale.push(...redCandleSignal.details);
    }
    if (setup === 'orb_breakout' && orbSignal.matched) {
      rationale.push(...orbSignal.details);
    }
    if (setup === 'momentum_continuation' && momentumSignal.matched) {
      rationale.push(...momentumSignal.details);
    }

    let suggestedEntry = stock.currentPrice ?? stock.buyZonePrice ?? 0;
    let suggestedStop: number;
    let suggestedTarget: number;

    if (setup === 'orb_breakout' && orbSignal.entry !== null && orbSignal.stop !== null) {
      // ORB: entry is the range-high break, stop is the range low. Target
      // prefers the Oracle sell zone when it clears 1R; otherwise a 1R
      // synthetic target so downstream filters still see a valid RR.
      suggestedEntry = stock.currentPrice ?? orbSignal.entry;
      suggestedStop = orbSignal.stop;
      const risk = suggestedEntry - suggestedStop;
      const oneRTarget = suggestedEntry + Math.max(risk, 0);
      suggestedTarget =
        stock.sellZonePrice && stock.sellZonePrice > oneRTarget ? stock.sellZonePrice : oneRTarget;
    } else if (
      setup === 'momentum_continuation' &&
      momentumSignal.matched &&
      momentumSignal.entry !== null &&
      momentumSignal.stop !== null
    ) {
      // Momentum: entry is the pullback-high break, stop is the pullback low.
      // Same sell-zone-vs-1R target preference as ORB so a too-close sell zone
      // doesn't cut R:R below filter thresholds.
      suggestedEntry = stock.currentPrice ?? momentumSignal.entry;
      suggestedStop = momentumSignal.stop;
      const risk = suggestedEntry - suggestedStop;
      const oneRTarget = suggestedEntry + Math.max(risk, 0);
      suggestedTarget =
        stock.sellZonePrice && stock.sellZonePrice > oneRTarget ? stock.sellZonePrice : oneRTarget;
    } else {
      // Clamp at 99% of max_risk_pct so downstream filters (which reject when
      // riskPct > max_risk_pct) don't trip on floating-point ties at exactly
      // the cap.
      const maxRiskStop = suggestedEntry * (1 - config.execution.max_risk_pct * 0.99);
      suggestedStop = redCandleSignal.matched && redCandleSignal.stop
        ? redCandleSignal.stop
        : Math.max(stock.stopPrice ?? 0, maxRiskStop);
      suggestedTarget = stock.sellZonePrice ?? 0;
    }

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
  }

  private scoreOracle(stock: StockState): number {
    let score = 0;

    if (stock.buyZonePrice && stock.stopPrice && stock.sellZonePrice) {
      score += 40;
      const risk = stock.buyZonePrice - stock.stopPrice;
      const reward = stock.sellZonePrice - stock.buyZonePrice;
      if (risk > 0 && reward > 0) {
        const rr = reward / risk;
        score += Math.min(30, rr * 10);
      }
    }

    if (typeof stock.profitDeltaPct === 'number') {
      if (stock.profitDeltaPct > 0) score += Math.min(15, stock.profitDeltaPct / 2);
      else score -= Math.min(10, Math.abs(stock.profitDeltaPct) / 4);
    }

    if (stock.trend30m === 'up') score += 15;
    if (stock.trend30m === 'down') score -= 10;

    return Math.max(0, Math.min(100, score));
  }

  private scoreExecution(stock: StockState, redCandleSignal: RedCandleSignal): number {
    let score = 50;

    if (typeof stock.premarketVolume === 'number') {
      if (stock.premarketVolume > 5_000_000) score += 25;
      else if (stock.premarketVolume > 1_000_000) score += 15;
      else if (stock.premarketVolume < 200_000) score -= 20;
    }

    if (stock.currentPrice !== null) {
      if (stock.currentPrice < 0.2) score -= 20;
      if (stock.currentPrice > 50) score -= 5;
    }

    if (redCandleSignal.matched) {
      score += 15;
      if (typeof redCandleSignal.rrToSellZone === 'number') {
        if (redCandleSignal.rrToSellZone >= 2) score += 10;
        else if (redCandleSignal.rrToSellZone < 1) score -= 8;
      }
    }

    return Math.max(0, Math.min(100, score));
  }

  private pickSetup(
    stock: StockState,
    tags: Partial<Record<SetupTag, number>>,
    redCandleSignal: RedCandleSignal,
    orbSignal: OrbSignal,
    momentumSignal: MomentumSignal,
  ): CandidateSetup | null {
    const hasTag = (tag: SetupTag): boolean => (tags[tag] ?? 0) > 0;

    if (redCandleSignal.matched) {
      return 'red_candle_theory';
    }

    if (orbSignal.matched && stock.trend30m !== 'down') {
      return 'orb_breakout';
    }

    if (momentumSignal.matched && stock.trend30m !== 'down') {
      return 'momentum_continuation';
    }

    if (
      (hasTag('vwap_reclaim') || hasTag('first_pullback')) &&
      stock.buyZonePrice !== null &&
      stock.stopPrice !== null &&
      this.isNearBuyZone(stock)
    ) {
      return 'pullback_reclaim';
    }

    if (hasTag('parabolic_extension') || hasTag('halt_risk')) {
      return 'crowded_extension_watch';
    }

    return null;
  }

  private isNearBuyZone(stock: StockState): boolean {
    const buy = stock.buyZonePrice;
    const current = stock.currentPrice;
    if (!buy || !current || buy <= 0) return false;
    // Allow current to be at or below buy zone (better entry), or up to
    // momentum_max_chase_pct above. Reject if we're chasing too hard.
    const pctAbove = (current - buy) / buy;
    return pctAbove <= config.execution.momentum_max_chase_pct;
  }

  private async detectOrbBreakout(stock: StockState): Promise<OrbSignal> {
    if (!config.execution.orb_enabled) return emptyOrbSignal();
    try {
      // 6.5h covers the full RTH session so a late-afternoon poll still sees
      // the 9:30 open bars.
      const bars = await fetchAlpaca1MinBars(stock.symbol, 390);
      return computeOrbSignal(stock, bars, new Date());
    } catch {
      return emptyOrbSignal();
    }
  }

  private async detectMomentumContinuation(stock: StockState): Promise<MomentumSignal> {
    if (!config.execution.momentum_enabled) return emptyMomentumSignal();
    try {
      const bars = await fetchAlpaca1MinBars(stock.symbol, 390);
      return computeMomentumSignal(stock, bars, new Date());
    } catch {
      return emptyMomentumSignal();
    }
  }

  private async detectRedCandleTheory(stock: StockState): Promise<RedCandleSignal> {
    try {
      const bars = await fetchAlpaca1MinBars(stock.symbol, 90);
      if (bars.length < 8) {
        return { matched: false, candleHigh: null, candleLow: null, entry: null, stop: null, rrToSellZone: null, details: [] };
      }

      const latest = bars[bars.length - 1];
      const avgRecentVolume =
        bars.slice(Math.max(0, bars.length - 6), bars.length - 1).reduce((sum, bar) => sum + bar.volume, 0) /
        Math.max(1, Math.min(5, bars.length - 1));

      let triggerBar: (typeof bars)[number] | null = null;
      for (let i = bars.length - 2; i >= Math.max(1, bars.length - 20); i--) {
        const bar = bars[i];
        const bodyPct = bar.open > 0 ? (bar.open - bar.close) / bar.open : 0;
        if (bar.close < bar.open && bodyPct >= 0.003) {
          triggerBar = bar;
          break;
        }
      }

      if (!triggerBar) {
        return { matched: false, candleHigh: null, candleLow: null, entry: null, stop: null, rrToSellZone: null, details: [] };
      }

      const reclaim = latest.close > triggerBar.high;
      const volumeConfirm = latest.volume >= avgRecentVolume * config.execution.red_candle_vol_mult;
      const risk = triggerBar.high - triggerBar.low;
      const reward = stock.sellZonePrice !== null && stock.sellZonePrice !== undefined
        ? stock.sellZonePrice - triggerBar.high
        : null;
      const rrToSellZone = reward !== null && risk > 0 ? reward / risk : null;

      const matched = reclaim && volumeConfirm && risk > 0;
      if (!matched) {
        return {
          matched: false,
          candleHigh: triggerBar.high,
          candleLow: triggerBar.low,
          entry: triggerBar.high,
          stop: triggerBar.low,
          rrToSellZone,
          details: [],
        };
      }

      const details = [
        `Red Candle Theory reclaim above ${triggerBar.high.toFixed(3)}`,
        `Suggested stop ${triggerBar.low.toFixed(3)} (red candle low)`,
      ];
      if (typeof rrToSellZone === 'number') {
        details.push(`Estimated R:R to sell zone ${rrToSellZone.toFixed(2)}x`);
      }

      return {
        matched: true,
        candleHigh: triggerBar.high,
        candleLow: triggerBar.low,
        entry: triggerBar.high,
        stop: triggerBar.low,
        rrToSellZone,
        details,
      };
    } catch {
      return { matched: false, candleHigh: null, candleLow: null, entry: null, stop: null, rrToSellZone: null, details: [] };
    }
  }
}

export const ruleEngineService = new RuleEngineService();
