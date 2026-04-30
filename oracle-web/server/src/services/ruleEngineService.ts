import { formatInTimeZone } from 'date-fns-tz';
import { StockState } from '../websocket/priceSocket.js';
import { fetchAlpaca1MinBars } from './alpacaBarService.js';
import { Bar } from './indicatorService.js';
import { SymbolMessageContext, messageService, SetupTag } from './messageService.js';
import { config } from '../config.js';
import { floatMapService, type FloatMapEntry } from './floatMapService.js';
import type { RegimeSnapshot } from './regimeService.js';

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

class RuleEngineService {
  async getRankedCandidates(stocks: StockState[], limit = 10, regime?: RegimeSnapshot): Promise<TradeCandidate[]> {
    const evaluated = await Promise.all(
      stocks.map(async (stock) => {
        const messageContext = messageService.getSymbolContext(stock.symbol);
        return this.evaluateStock(stock, messageContext, regime);
      })
    );

    const candidates = evaluated.filter((candidate): candidate is TradeCandidate => candidate !== null);

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, Math.max(1, Math.min(limit, 100)));
  }

  private async evaluateStock(stock: StockState, messageContext: SymbolMessageContext, regime?: RegimeSnapshot): Promise<TradeCandidate | null> {
    const [redCandleSignal, orbSignal] = await Promise.all([
      this.detectRedCandleTheory(stock),
      this.detectOrbBreakout(stock),
    ]);
    return this.scoreFromInputs(stock, messageContext, redCandleSignal, orbSignal, regime);
  }

  /**
   * Pure scoring path. Takes pre-resolved inputs (message context + red-candle
   * signal + ORB signal) and returns the candidate without touching any I/O —
   * exposed so offline tooling (historical replay, unit tests) can feed
   * synthesized inputs through the same scoring logic the live bot uses.
   */
  scoreFromInputs(
    stock: StockState,
    messageContext: SymbolMessageContext,
    redCandleSignal: RedCandleSignal,
    orbSignal: OrbSignal = emptyOrbSignal(),
    regime?: RegimeSnapshot,
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

    if (regime && config.execution.regime.enabled) {
      const cfg = config.execution.regime;
      const tickerRegime = regime.tickers[stock.symbol];
      const sectorRegime = tickerRegime
        ? this.findSectorRegimeForTicker(regime, tickerRegime.sector)
        : undefined;
      const composite =
        cfg.market_weight * (regime.market.score ?? 0) +
        cfg.sector_weight * (sectorRegime?.score ?? 0) +
        cfg.ticker_weight * (tickerRegime?.score ?? 0);
      weighted += composite * cfg.score_weight;
    }

    // Float-rotation theory: any symbol on the FloatMAP list gets a base bump
    // (StocksToTrade has already curated for "interesting rotation"). Add a
    // second bump when rotation sits in the prime band — high enough to fuel
    // continuation, not so high that it's blowing off.
    const floatEntry = this.getFreshFloatEntry(stock.symbol);
    const floatCfg = config.execution.float_rotation;
    if (floatEntry && floatCfg) {
      weighted += floatCfg.score_bump_base;
      if (
        floatEntry.rotation !== null &&
        floatEntry.rotation >= floatCfg.prime_band_min &&
        floatEntry.rotation <= floatCfg.prime_band_max
      ) {
        weighted += floatCfg.score_bump_prime;
      }
    }

    const setup = this.pickSetup(stock, messageContext.tagCounts, redCandleSignal, orbSignal);
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
    if (floatEntry && floatCfg) {
      const rotStr = floatEntry.rotation !== null ? `${floatEntry.rotation.toFixed(1)}x` : 'n/a';
      rationale.push(`FloatMAP listed (rotation ${rotStr}) +${floatCfg.score_bump_base}`);
      if (
        floatEntry.rotation !== null &&
        floatEntry.rotation >= floatCfg.prime_band_min &&
        floatEntry.rotation <= floatCfg.prime_band_max
      ) {
        rationale.push(
          `Prime rotation band [${floatCfg.prime_band_min}x, ${floatCfg.prime_band_max}x] +${floatCfg.score_bump_prime}`,
        );
      }
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
  ): CandidateSetup | null {
    const hasTag = (tag: SetupTag): boolean => (tags[tag] ?? 0) > 0;

    if (
      redCandleSignal.matched &&
      (hasTag('red_to_green') || hasTag('first_pullback') || hasTag('vwap_reclaim') || hasTag('gap_and_go'))
    ) {
      return 'red_candle_theory';
    }

    if (redCandleSignal.matched) {
      return 'red_candle_theory';
    }

    if (orbSignal.matched && stock.trend30m !== 'down') {
      return 'orb_breakout';
    }

    if (
      (hasTag('gap_and_go') || hasTag('orb_break')) &&
      stock.buyZonePrice !== null &&
      stock.stopPrice !== null &&
      stock.trend30m !== 'down' &&
      this.isMomentumSetupValid(stock)
    ) {
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

    if (
      stock.buyZonePrice !== null &&
      stock.stopPrice !== null &&
      stock.sellZonePrice !== null &&
      this.isMomentumSetupValid(stock)
    ) {
      // Fallback candidate when structure is good but message tags are sparse.
      return 'momentum_continuation';
    }

    return null;
  }

  /**
   * Gate momentum entries:
   *  - optionally require 30m uptrend
   *  - require premarket gap >= momentum_gap_pct (from oracle lastPrice)
   *  - require current price within momentum_max_chase_pct above buy zone
   *    (prevents chase fills 10-50% above the Oracle entry zone)
   */
  private isMomentumSetupValid(stock: StockState): boolean {
    const exec = config.execution;

    if (exec.require_uptrend_for_momentum && stock.trend30m !== 'up') {
      return false;
    }

    const currentPrice = stock.currentPrice;
    if (currentPrice === null) return false;

    const lastPrice = stock.lastPrice;
    if (lastPrice && lastPrice > 0) {
      const gapPct = (currentPrice - lastPrice) / lastPrice;
      if (gapPct < exec.momentum_gap_pct) return false;
    }

    return this.isNearBuyZone(stock);
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

  private getFreshFloatEntry(symbol: string): FloatMapEntry | null {
    const cfg = config.execution.float_rotation;
    if (!cfg?.enabled) return null;
    return floatMapService.getEntryForSymbol(symbol, cfg.max_age_seconds);
  }

  private findSectorRegimeForTicker(regime: RegimeSnapshot, sector: string) {
    const etf = this.etfForSector(sector);
    return regime.sectors[etf];
  }

  private etfForSector(sector: string): string {
    const map: Record<string, string> = {
      materials: 'XLB', communications: 'XLC', energy: 'XLE', financials: 'XLF',
      industrials: 'XLI', technology: 'XLK', software: 'IGV',
      consumer_staples: 'XLP', real_estate: 'XLRE', utilities: 'XLU',
      healthcare: 'XLV', consumer_discretionary: 'XLY', biotechnology: 'XBI',
      unknown: 'SPY',
    };
    return map[sector] ?? 'SPY';
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
