import { Link } from 'react-router-dom';
import { ActiveTrade, JournalSnapshot } from '../types';

interface ActiveTradesStripProps {
  snapshot: JournalSnapshot | null;
}

function trailingBadgeClass(s: ActiveTrade['trailingState']): string {
  switch (s) {
    case 'initial': return 'bg-gray-100 text-gray-700';
    case 'mfe_lock': return 'bg-purple-100 text-purple-800';
    case 'breakeven': return 'bg-blue-100 text-blue-800';
    case 'trailing': return 'bg-green-100 text-green-800';
  }
}

function trailingLabel(t: ActiveTrade): string {
  const lockedR =
    t.riskPerShare > 0 ? (t.currentStop - t.entryPrice) / t.riskPerShare : 0;
  const suffix =
    lockedR > 0.01 ? ` +${lockedR.toFixed(1)}R` : lockedR < -0.01 ? ` ${lockedR.toFixed(1)}R` : '';
  switch (t.trailingState) {
    case 'initial': return 'Initial';
    case 'mfe_lock': return `MFE Lock${suffix}`;
    case 'breakeven': return 'Breakeven';
    case 'trailing': return `Trailing${suffix}`;
  }
}

function pnlColor(v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0) return 'text-gray-600';
  return v > 0 ? 'text-green-700' : 'text-red-700';
}

function money(v: number): string {
  const sign = v >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

export function ActiveTradesStrip({ snapshot }: ActiveTradesStripProps) {
  if (!snapshot) return null;
  const active = snapshot.active.filter((t) => t.status === 'filled');
  if (active.length === 0) return null;

  return (
    <section className="bg-white rounded-lg shadow p-3">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Active Trades
        </h2>
        <span className="text-xs text-gray-400">{active.length} open</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {active.map((t) => {
          const rMult =
            t.riskPerShare > 0 && t.currentPrice !== null && t.currentPrice !== undefined
              ? (t.currentPrice - t.entryPrice) / t.riskPerShare
              : null;
          return (
            <div
              key={t.symbol}
              className="flex flex-col gap-1 border border-gray-200 rounded px-3 py-2 min-w-[180px]"
            >
              <div className="flex items-center justify-between gap-2">
                <Link
                  to={`/symbol/${t.symbol}`}
                  className="font-bold text-gray-900 hover:underline"
                >
                  {t.symbol}
                </Link>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded ${trailingBadgeClass(t.trailingState)}`}
                >
                  {trailingLabel(t)}
                </span>
              </div>
              <div className="flex items-baseline justify-between text-xs tabular-nums">
                <span className="text-gray-500">
                  {t.currentPrice !== null && t.currentPrice !== undefined
                    ? `$${t.currentPrice.toFixed(3)}`
                    : '--'}
                </span>
                <span className={pnlColor(t.unrealizedPl)}>
                  {t.unrealizedPl !== null && t.unrealizedPl !== undefined
                    ? `${money(t.unrealizedPl)}${rMult !== null ? ` (${rMult >= 0 ? '+' : ''}${rMult.toFixed(1)}R)` : ''}`
                    : '--'}
                </span>
              </div>
              <div className="flex items-baseline justify-between text-[11px] text-gray-500 tabular-nums">
                <span>Stop ${t.currentStop.toFixed(3)}</span>
                <span>Tgt ${t.target.toFixed(3)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
