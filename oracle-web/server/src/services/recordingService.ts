import { appendFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { formatInTimeZone } from 'date-fns-tz';
import { config } from '../config.js';
import { StockState } from '../websocket/priceSocket.js';
import { TradeCandidate, CandidateSetup } from './ruleEngineService.js';
import { ActiveTrade, TradeLedgerEntry, FilterRejection } from './executionService.js';
import type { RegimeSnapshot } from './regimeService.js';

export interface RecordedItem {
  symbol: string;
  currentPrice: number | null;
  lastPrice: number | null;
  changePercent: number | null;
  stopPrice: number | null;
  buyZonePrice: number | null;
  sellZonePrice: number | null;
  profitDeltaPct: number | null;
  maxVolume: number | null;
  premarketVolume: number | null;
  relativeVolume: number | null;
  floatMillions: number | null;
  signal: string | null;
  trend30m: 'up' | 'down' | 'flat' | null;
  boxTop: number | null;
  boxBottom: number | null;
}

export interface RecordedDecision {
  symbol: string;
  kind: 'candidate' | 'rejection';
  setup: CandidateSetup;
  score: number;
  rationale: string[];
  rejectionReason?: string;
  // Strategy-resolved levels — present when the rule engine recommended a
  // specific entry/stop/target that differs from the Oracle defaults (e.g.
  // ORB uses the opening-range low as the stop). Backtest replay prefers
  // these over the Oracle levels from RecordedItem when available.
  suggestedEntry?: number | null;
  suggestedStop?: number | null;
  suggestedTarget?: number | null;
}

export interface CycleRecord {
  ts: string;
  tsEt: string;
  tradingDay: string;
  marketStatus: {
    isOpen: boolean;
    openTime: string;
    closeTime: string;
  };
  items: RecordedItem[];
  decisions: RecordedDecision[];
  activeTrades: ActiveTrade[];
  closedTrades: TradeLedgerEntry[];
  regime?: RegimeSnapshot | null;
}

export interface CycleInputs {
  stocks: StockState[];
  candidates: TradeCandidate[];
  rejections: FilterRejection[];
  activeTrades: ActiveTrade[];
  closedTrades: TradeLedgerEntry[];
  marketStatus: { isOpen: boolean; openTime: string; closeTime: string };
  regime?: RegimeSnapshot | null;
}

function toRecordedItem(s: StockState): RecordedItem {
  return {
    symbol: s.symbol,
    currentPrice: s.currentPrice,
    lastPrice: s.lastPrice ?? null,
    changePercent: s.changePercent,
    stopPrice: s.stopPrice ?? null,
    buyZonePrice: s.buyZonePrice ?? null,
    sellZonePrice: s.sellZonePrice ?? null,
    profitDeltaPct: s.profitDeltaPct ?? null,
    maxVolume: s.maxVolume ?? null,
    premarketVolume: s.premarketVolume ?? null,
    relativeVolume: s.relativeVolume ?? null,
    floatMillions: s.floatMillions ?? null,
    signal: s.signal,
    trend30m: s.trend30m,
    boxTop: s.boxTop,
    boxBottom: s.boxBottom,
  };
}

function toDecisions(candidates: TradeCandidate[], rejections: FilterRejection[]): RecordedDecision[] {
  const out: RecordedDecision[] = [];
  for (const c of candidates) {
    out.push({
      symbol: c.symbol,
      kind: 'candidate',
      setup: c.setup,
      score: c.score,
      rationale: c.rationale,
      suggestedEntry: c.suggestedEntry,
      suggestedStop: c.suggestedStop,
      suggestedTarget: c.suggestedTarget,
    });
  }
  for (const r of rejections) {
    out.push({
      symbol: r.symbol,
      kind: 'rejection',
      setup: r.setup,
      score: r.score,
      rationale: [],
      rejectionReason: r.reason,
    });
  }
  return out;
}

export class RecordingService {
  private ensuredDirs = new Set<string>();

  async writeCycle(inputs: CycleInputs, now: Date = new Date()): Promise<void> {
    if (!config.recording.enabled) return;

    const tz = config.market_hours.timezone;
    const tradingDay = formatInTimeZone(now, tz, 'yyyy-MM-dd');
    const tsEt = formatInTimeZone(now, tz, 'HH:mm:ss');

    const record: CycleRecord = {
      ts: now.toISOString(),
      tsEt,
      tradingDay,
      marketStatus: inputs.marketStatus,
      items: inputs.stocks.map(toRecordedItem),
      decisions: toDecisions(inputs.candidates, inputs.rejections),
      activeTrades: inputs.activeTrades,
      closedTrades: inputs.closedTrades,
      regime: inputs.regime ?? null,
    };

    const filePath = resolve(config.recording.dir, `${tradingDay}.jsonl`);
    await this.ensureDir(dirname(filePath));
    await appendFile(filePath, JSON.stringify(record) + '\n', 'utf-8');
  }

  private async ensureDir(dir: string): Promise<void> {
    if (this.ensuredDirs.has(dir)) return;
    await mkdir(dir, { recursive: true });
    this.ensuredDirs.add(dir);
  }
}

export const recordingService = new RecordingService();
