import { ClosedTrade } from '../types';

interface DaySummaryCardProps {
  date: string;
  closed: ClosedTrade[];
  isToday: boolean;
  openPositions?: number;
  lastCycleAt?: string | null;
}

function money(v: number, prefix: string = '$'): string {
  const sign = v < 0 ? '-' : '';
  return `${sign}${prefix}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pnlColor(v: number): string {
  if (v > 0.01) return 'text-green-700';
  if (v < -0.01) return 'text-red-700';
  return 'text-gray-600';
}

function fmtDate(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return Number.isNaN(d.getTime())
    ? date
    : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

interface StatProps {
  label: string;
  value: string;
  color?: string;
  sub?: string;
}

function Stat({ label, value, color = 'text-gray-900', sub }: StatProps) {
  return (
    <div>
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 tabular-nums">{sub}</div>}
    </div>
  );
}

export function DaySummaryCard({ date, closed, isToday, openPositions, lastCycleAt }: DaySummaryCardProps) {
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const wins = closed.filter((t) => t.pnl > 0).length;
  const losses = closed.filter((t) => t.pnl < 0).length;
  const trades = closed.length;
  const winRate = trades > 0 ? (wins / trades) * 100 : 0;
  const avgR = trades > 0 ? closed.reduce((s, t) => s + t.rMultiple, 0) / trades : 0;
  const best = trades > 0 ? Math.max(...closed.map((t) => t.pnl)) : 0;
  const worst = trades > 0 ? Math.min(...closed.map((t) => t.pnl)) : 0;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-900">
          {fmtDate(date)}
          {isToday && (
            <span className="ml-2 text-xs font-normal bg-green-100 text-green-800 px-2 py-0.5 rounded">
              LIVE
            </span>
          )}
        </h2>
        {lastCycleAt && !isToday && (
          <span className="text-xs text-gray-500">Last recorded {fmtTime(lastCycleAt)}</span>
        )}
      </div>
      {trades === 0 && (isToday ? openPositions : 0) === 0 ? (
        <div className="text-sm text-gray-500">
          {isToday ? 'No trades yet today.' : 'No trades recorded on this day.'}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          <Stat label="Realized P&L" value={money(totalPnl)} color={pnlColor(totalPnl)} />
          <Stat label="Trades" value={`${trades}`} sub={trades > 0 ? `${wins}W / ${losses}L` : undefined} />
          <Stat label="Win Rate" value={trades > 0 ? `${winRate.toFixed(0)}%` : '--'} />
          <Stat
            label="Avg R"
            value={trades > 0 ? `${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R` : '--'}
            color={pnlColor(avgR)}
          />
          <Stat label="Best" value={trades > 0 ? money(best) : '--'} color={pnlColor(best)} />
          <Stat label="Worst" value={trades > 0 ? money(worst) : '--'} color={pnlColor(worst)} />
          {isToday && openPositions !== undefined && (
            <Stat label="Open Now" value={`${openPositions}`} />
          )}
        </div>
      )}
    </div>
  );
}
