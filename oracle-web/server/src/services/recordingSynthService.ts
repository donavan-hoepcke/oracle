import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { config } from '../config.js';
import type { CycleRecord, RecordedItem, RecordedDecision } from './recordingService.js';

export const DEFAULT_SYNTH_TICKERS = [
  'AGAE', 'HUBC', 'MULN', 'NVAX', 'SOS',
  'BBIG', 'GREE', 'GNS', 'MRIN', 'TOP',
  'AITX', 'CYN', 'ESSA', 'FAMI', 'GFAI',
];

export interface SynthOptions {
  day: string;
  tickers?: string[];
  seed?: number;
  cyclesPerDay?: number;
  outputDir?: string;
}

export interface SynthResult {
  filePath: string;
  day: string;
  tickers: string[];
  cyclesWritten: number;
  seed: number;
  outcomes: { win: number; loss: number; chop: number };
}

type Outcome = 'win' | 'loss' | 'chop';

interface TickerPlan {
  symbol: string;
  basePrice: number;
  stopPrice: number;
  buyZone: number;
  sellZone: number;
  outcome: Outcome;
  floatMillions: number;
  entryCycle: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function planTicker(symbol: string, rnd: () => number): TickerPlan {
  const basePrice = Math.round((0.5 + rnd() * 7.5) * 1000) / 1000;
  const stopPct = 0.06 + rnd() * 0.04;
  const stopPrice = Math.round(basePrice * (1 - stopPct) * 1000) / 1000;
  const targetPct = 0.15 + rnd() * 0.15;
  const sellZone = Math.round(basePrice * (1 + targetPct) * 1000) / 1000;
  const buyZone = basePrice;

  const r = rnd();
  const outcome: Outcome = r < 0.35 ? 'win' : r < 0.65 ? 'loss' : 'chop';
  const floatMillions = Math.round((5 + rnd() * 45) * 10) / 10;
  const entryCycle = Math.floor(rnd() * 30);

  return { symbol, basePrice, stopPrice, buyZone, sellZone, outcome, floatMillions, entryCycle };
}

function walkPrice(current: number, target: number, remaining: number, rnd: () => number): number {
  if (remaining <= 1) return target;
  const drift = (target - current) / remaining;
  const noise = (rnd() - 0.5) * Math.abs(current) * 0.015;
  return Math.max(0.01, Math.round((current + drift + noise) * 1000) / 1000);
}

function generatePriceSeries(plan: TickerPlan, cycles: number, rnd: () => number): number[] {
  const prices: number[] = [];
  let price = plan.basePrice * (0.97 + rnd() * 0.04);

  for (let i = 0; i < plan.entryCycle; i++) {
    price = walkPrice(price, plan.basePrice, Math.max(2, plan.entryCycle - i), rnd);
    prices.push(Math.round(price * 1000) / 1000);
  }

  const post = cycles - plan.entryCycle;
  let destination: number;
  switch (plan.outcome) {
    case 'win':
      destination = plan.sellZone * (1.0 + rnd() * 0.03);
      break;
    case 'loss':
      destination = plan.stopPrice * (0.98 - rnd() * 0.02);
      break;
    case 'chop':
      destination = plan.basePrice * (0.98 + rnd() * 0.04);
      break;
  }

  const arrivalCycle = plan.outcome === 'loss'
    ? plan.entryCycle + Math.floor(post * (0.2 + rnd() * 0.3))
    : plan.outcome === 'win'
      ? plan.entryCycle + Math.floor(post * (0.4 + rnd() * 0.4))
      : cycles;

  for (let i = plan.entryCycle; i < cycles; i++) {
    const remaining = Math.max(2, arrivalCycle - i);
    price = walkPrice(price, destination, remaining, rnd);
    prices.push(Math.round(price * 1000) / 1000);
  }
  return prices;
}

export function synthesizeDay(opts: SynthOptions): SynthResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.day)) {
    throw new Error(`Invalid day: ${opts.day} (expected YYYY-MM-DD)`);
  }
  const tickers = (opts.tickers && opts.tickers.length > 0 ? opts.tickers : DEFAULT_SYNTH_TICKERS)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  if (tickers.length === 0) {
    throw new Error('At least one ticker is required');
  }
  const seed = opts.seed ?? 42;
  const cyclesPerDay = opts.cyclesPerDay ?? 78;
  const outputDir = opts.outputDir ?? config.recording.dir;

  const rnd = mulberry32(seed);
  const plans = tickers.map((t) => planTicker(t, rnd));

  const priceSeries = new Map<string, number[]>();
  for (const plan of plans) {
    priceSeries.set(plan.symbol, generatePriceSeries(plan, cyclesPerDay, rnd));
  }

  const [year, month, dayNum] = opts.day.split('-').map(Number);
  const cycles: CycleRecord[] = [];
  const seenCandidates = new Set<string>();

  for (let i = 0; i < cyclesPerDay; i++) {
    const totalMinutes = 9 * 60 + 30 + i * 5;
    const hh = Math.floor(totalMinutes / 60);
    const mm = totalMinutes % 60;
    const ts = new Date(Date.UTC(year, month - 1, dayNum, hh + 4, mm, 0)).toISOString();
    const tsEt = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;

    const items: RecordedItem[] = plans.map((plan) => {
      const prices = priceSeries.get(plan.symbol)!;
      const price = prices[i] ?? plan.basePrice;
      const lastPrice = prices[i - 1] ?? plan.basePrice;
      return {
        symbol: plan.symbol,
        currentPrice: price,
        lastPrice,
        changePercent: Math.round(((price - plan.basePrice) / plan.basePrice) * 10000) / 100,
        stopPrice: plan.stopPrice,
        buyZonePrice: plan.buyZone,
        sellZonePrice: plan.sellZone,
        profitDeltaPct: Math.round(((plan.sellZone - plan.buyZone) / plan.buyZone) * 10000) / 100,
        maxVolume: null,
        premarketVolume: null,
        relativeVolume: 1 + rnd() * 2,
        floatMillions: plan.floatMillions,
        signal: null,
        trend30m: plan.outcome === 'win' ? 'up' : plan.outcome === 'loss' ? 'down' : 'flat',
        boxTop: null,
        boxBottom: null,
      };
    });

    const decisions: RecordedDecision[] = [];
    for (const plan of plans) {
      if (i === plan.entryCycle && !seenCandidates.has(plan.symbol)) {
        seenCandidates.add(plan.symbol);
        decisions.push({
          symbol: plan.symbol,
          kind: 'candidate',
          setup: 'momentum_continuation',
          score: 70 + Math.floor(rnd() * 25),
          rationale: [
            `Buy zone ${plan.buyZone.toFixed(3)} available`,
            `Stop reference ${plan.stopPrice.toFixed(3)}`,
            `Sell zone ${plan.sellZone.toFixed(3)} available`,
          ],
        });
      }
    }

    cycles.push({
      ts,
      tsEt,
      tradingDay: opts.day,
      marketStatus: { isOpen: true, openTime: '09:30', closeTime: '16:00' },
      items,
      decisions,
      activeTrades: [],
      closedTrades: [],
    });
  }

  const filePath = resolve(outputDir, `${opts.day}.jsonl`);
  if (!existsSync(dirname(filePath))) {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const payload = cycles.map((c) => JSON.stringify(c)).join('\n') + '\n';
  writeFileSync(filePath, payload, 'utf-8');

  return {
    filePath,
    day: opts.day,
    tickers,
    cyclesWritten: cycles.length,
    seed,
    outcomes: {
      win: plans.filter((p) => p.outcome === 'win').length,
      loss: plans.filter((p) => p.outcome === 'loss').length,
      chop: plans.filter((p) => p.outcome === 'chop').length,
    },
  };
}
