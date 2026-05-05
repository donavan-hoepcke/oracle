import { formatInTimeZone } from 'date-fns-tz';
import { config } from '../config.js';
import { brokerService } from './brokers/index.js';
import type { BrokerOrder } from '../types/broker.js';
import { TradeLedgerEntry } from './executionService.js';

/**
 * Pair each closed trade with the Alpaca sell fill that actually closed
 * it and rewrite exitPrice/pnl/pnlPct/rMultiple from the real fill.
 * A trade is only reconciled when a sell fill with the exact same
 * symbol and qty filled after the entry is available and hasn't
 * already been claimed by another trade.
 *
 * Exported for unit testing; no I/O.
 */
export function applyFillsToLedger(
  trades: TradeLedgerEntry[],
  fills: BrokerOrder[],
): { reconciled: TradeLedgerEntry[]; changed: number } {
  const sellFills = fills
    .filter(
      (o) =>
        o.side === 'sell' &&
        o.status === 'filled' &&
        o.filledAvgPrice !== null &&
        o.filledAt !== null &&
        o.filledQty !== null,
    )
    .map((o) => ({ ...o, filledAtMs: Date.parse(o.filledAt as string) }))
    .sort((a, b) => a.filledAtMs - b.filledAtMs);

  const out = trades.map((t) => ({ ...t }));
  const ordered = out
    .map((t, i) => ({ t, i, entryMs: new Date(t.entryTime).getTime() }))
    .sort((a, b) => a.entryMs - b.entryMs);
  const claimed = new Set<string>();
  let changed = 0;

  for (const { t, i, entryMs } of ordered) {
    const match = sellFills.find(
      (f) =>
        !claimed.has(f.id) &&
        f.symbol === t.symbol &&
        Math.round(f.filledQty as number) === Math.round(t.shares) &&
        f.filledAtMs >= entryMs,
    );
    if (!match) continue;
    claimed.add(match.id);

    const exitPrice = match.filledAvgPrice as number;
    if (Math.abs(exitPrice - t.exitPrice) < 1e-6) continue;

    const pnl = (exitPrice - t.entryPrice) * t.shares;
    const pnlPct = t.entryPrice > 0 ? ((exitPrice - t.entryPrice) / t.entryPrice) * 100 : 0;
    const rMultiple = t.riskPerShare > 0 ? (exitPrice - t.entryPrice) / t.riskPerShare : t.rMultiple;

    out[i] = {
      ...t,
      exitPrice,
      exitTime: new Date(match.filledAt as string),
      pnl,
      pnlPct,
      rMultiple,
      exitDetail: t.exitDetail
        ? `${t.exitDetail} (reconciled from Alpaca fill)`
        : 'Reconciled from Alpaca fill',
    };
    changed++;
  }

  return { reconciled: out, changed };
}

function dayBoundsUtc(date: string): { afterIso: string; untilIso: string } {
  const tz = config.market_hours.timezone;
  const start = new Date(formatInTimeZone(new Date(`${date}T12:00:00Z`), tz, "yyyy-MM-dd'T'00:00:00XXX"));
  const next = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { afterIso: start.toISOString(), untilIso: next.toISOString() };
}

export interface ReconcileResult {
  trades: TradeLedgerEntry[];
  changed: number;
  reconciled: boolean;
}

export class TradeReconciliationService {
  private cache = new Map<string, TradeLedgerEntry[]>();

  invalidate(date?: string): void {
    if (date) this.cache.delete(date);
    else this.cache.clear();
  }

  async reconcileDay(date: string, trades: TradeLedgerEntry[]): Promise<ReconcileResult> {
    if (trades.length === 0) return { trades, changed: 0, reconciled: false };
    const cached = this.cache.get(date);
    if (cached && cached.length === trades.length) {
      return { trades: cached, changed: 0, reconciled: true };
    }

    const { afterIso } = dayBoundsUtc(date);
    let orders: BrokerOrder[] = [];
    try {
      orders = await brokerService.getOrdersSince(afterIso, 'closed');
    } catch (err) {
      console.warn(`reconcileDay(${date}) fetch failed:`, err instanceof Error ? err.message : err);
      return { trades, changed: 0, reconciled: false };
    }
    const { reconciled, changed } = applyFillsToLedger(trades, orders);
    if (changed > 0) {
      this.cache.set(date, reconciled);
      return { trades: reconciled, changed, reconciled: true };
    }
    return { trades, changed: 0, reconciled: true };
  }
}

export const tradeReconciliationService = new TradeReconciliationService();
