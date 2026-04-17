import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { config } from '../config.js';
import type {
  CycleRecord,
  RecordedItem,
  RecordedDecision,
} from '../services/recordingService.js';

const DEFAULT_TICKERS = [
  'AGAE', 'HUBC', 'MULN', 'NVAX', 'SOS',
  'BBIG', 'GREE', 'GNS', 'MRIN', 'TOP',
  'AITX', 'CYN', 'ESSA', 'FAMI', 'GFAI',
];

interface SynthArgs {
  day: string;
  tickers: string[];
  seed: number;
}

function parseArgs(): SynthArgs {
  const args = process.argv.slice(2);
  let day = new Date().toISOString().slice(0, 10);
  let tickers = DEFAULT_TICKERS;
  let seed = 42;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--day' && args[i + 1]) {
      day = args[i + 1];
      i++;
    } else if (args[i] === '--tickers' && args[i + 1]) {
      tickers = args[i + 1].split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
      i++;
    } else if (args[i] === '--seed' && args[i + 1]) {
      seed = Number(args[i + 1]);
      i++;
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`Invalid --day: ${day}`);
  }
  return { day, tickers, seed };
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

function planTicker(symbol: string, rnd: () => number): TickerPlan {
  // Small-cap style: base price between $0.50 and $8
  const basePrice = Math.round((0.5 + rnd() * 7.5) * 1000) / 1000;
  // Risk 6-10% below base
  const stopPct = 0.06 + rnd() * 0.04;
  const stopPrice = Math.round(basePrice * (1 - stopPct) * 1000) / 1000;
  // Target 15-30% above base
  const targetPct = 0.15 + rnd() * 0.15;
  const sellZone = Math.round(basePrice * (1 + targetPct) * 1000) / 1000;
  const buyZone = basePrice;

  const r = rnd();
  const outcome: Outcome = r < 0.35 ? 'win' : r < 0.65 ? 'loss' : 'chop';
  const floatMillions = Math.round((5 + rnd() * 45) * 10) / 10;
  // Entry candidate emits somewhere in the first third of the day
  const entryCycle = Math.floor(rnd() * 30);

  return { symbol, basePrice, stopPrice, buyZone, sellZone, outcome, floatMillions, entryCycle };
}

// Walk price toward a target over the remaining cycles, with noise.
function walkPrice(current: number, target: number, remaining: number, rnd: () => number): number {
  if (remaining <= 1) return target;
  const drift = (target - current) / remaining;
  const noise = (rnd() - 0.5) * Math.abs(current) * 0.015;
  return Math.max(0.01, Math.round((current + drift + noise) * 1000) / 1000);
}

function generatePriceSeries(plan: TickerPlan, cycles: number, rnd: () => number): number[] {
  const prices: number[] = [];
  let price = plan.basePrice * (0.97 + rnd() * 0.04); // open near base

  // Pre-entry: drift near base
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

  // Losers fail faster, winners run steadier, chop is slow
  const arrivalCycle = plan.outcome === 'loss'
    ? plan.entryCycle + Math.floor(post * (0.2 + rnd() * 0.3))
    : plan.outcome === 'win'
      ? plan.entryCycle + Math.floor(post * (0.4 + rnd() * 0.4))
      : cycles;

  for (let i = plan.entryCycle; i < cycles; i++) {
    const remaining = Math.max(2, arrivalCycle - i);
    price = walkPrice(price, i < arrivalCycle ? destination : destination, remaining, rnd);
    prices.push(Math.round(price * 1000) / 1000);
  }
  return prices;
}

function main(): void {
  const { day, tickers, seed } = parseArgs();
  const rnd = mulberry32(seed);

  const plans = tickers.map((t) => planTicker(t, rnd));

  // 78 cycles: every 5 minutes from 09:30 to 16:00 ET
  const cyclesPerDay = 78;
  const priceSeries = new Map<string, number[]>();
  for (const plan of plans) {
    priceSeries.set(plan.symbol, generatePriceSeries(plan, cyclesPerDay, rnd));
  }

  const [year, month, dayNum] = day.split('-').map(Number);
  const cycles: CycleRecord[] = [];
  const seenCandidates = new Set<string>();

  for (let i = 0; i < cyclesPerDay; i++) {
    // 09:30 ET + 5*i minutes.
    const totalMinutes = 9 * 60 + 30 + i * 5;
    const hh = Math.floor(totalMinutes / 60);
    const mm = totalMinutes % 60;
    // ET -> UTC (+4 during DST; we assume DST since recordings are only kept short-term)
    const ts = new Date(Date.UTC(year, month - 1, dayNum, hh + 4, mm, 0)).toISOString();
    const tsEt = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;

    const items: RecordedItem[] = plans.map((plan) => {
      const prices = priceSeries.get(plan.symbol)!;
      const price = prices[i] ?? plan.basePrice;
      const lastPrice = prices[i - 1] ?? plan.basePrice;
      const changePercent = ((price - plan.basePrice) / plan.basePrice) * 100;
      return {
        symbol: plan.symbol,
        currentPrice: price,
        lastPrice,
        changePercent: Math.round(changePercent * 100) / 100,
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
      tradingDay: day,
      marketStatus: { isOpen: true, openTime: '09:30', closeTime: '16:00' },
      items,
      decisions,
      activeTrades: [],
      closedTrades: [],
    });
  }

  const outPath = resolve(config.recording.dir, `${day}.jsonl`);
  if (!existsSync(dirname(outPath))) {
    mkdirSync(dirname(outPath), { recursive: true });
  }
  const payload = cycles.map((c) => JSON.stringify(c)).join('\n') + '\n';
  writeFileSync(outPath, payload, 'utf-8');

  const winCount = plans.filter((p) => p.outcome === 'win').length;
  const lossCount = plans.filter((p) => p.outcome === 'loss').length;
  const chopCount = plans.filter((p) => p.outcome === 'chop').length;
  console.log(`Wrote ${cycles.length} cycles for ${tickers.length} tickers to ${outPath}`);
  console.log(`Planned outcomes: ${winCount} win, ${lossCount} loss, ${chopCount} chop (seed=${seed})`);
}

main();
