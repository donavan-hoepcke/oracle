import { useState } from 'react';
import { BacktestResult, BacktestTrade, EquityPoint } from '../types';
import { useBacktest } from '../hooks/useBacktest';

function money(v: number): string {
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pnlColor(v: number): string {
  if (v > 0.01) return 'text-green-700';
  if (v < -0.01) return 'text-red-700';
  return 'text-gray-600';
}

function exitReasonBadge(r: BacktestTrade['exitReason']): string {
  switch (r) {
    case 'target': return 'bg-green-100 text-green-800';
    case 'trailing_stop': return 'bg-yellow-100 text-yellow-800';
    case 'stop': return 'bg-red-100 text-red-800';
    case 'eod': return 'bg-gray-100 text-gray-700';
    default: return 'bg-gray-100 text-gray-700';
  }
}

function timeEt(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return '--';
  }
}

interface EquityChartProps {
  points: EquityPoint[];
  startingEquity: number;
}

function EquityChart({ points, startingEquity }: EquityChartProps) {
  if (points.length === 0) {
    return <div className="text-sm text-gray-500">No equity data</div>;
  }
  const width = 640;
  const height = 120;
  const padX = 4;
  const padY = 6;

  const equities = points.map((p) => p.equity);
  const min = Math.min(startingEquity, ...equities);
  const max = Math.max(startingEquity, ...equities);
  const range = max - min || 1;

  const x = (i: number) => padX + (i / Math.max(points.length - 1, 1)) * (width - 2 * padX);
  const y = (v: number) => padY + (1 - (v - min) / range) * (height - 2 * padY);

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.equity).toFixed(1)}`)
    .join(' ');

  const baselineY = y(startingEquity);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-32 text-blue-600">
      <line
        x1={padX}
        x2={width - padX}
        y1={baselineY}
        y2={baselineY}
        stroke="#9ca3af"
        strokeDasharray="3,3"
        strokeWidth={1}
      />
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

interface ResultsProps {
  result: BacktestResult;
}

function Results({ result }: ResultsProps) {
  const { summary, trades, equityCurve, skipped } = result;
  const closed = trades.filter((t) => t.exitReason);
  const skippedByReason = skipped.reduce<Record<string, number>>((acc, s) => {
    acc[s.reason] = (acc[s.reason] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900">
            Results for {result.tradingDay}
            <span className="ml-2 text-xs font-normal bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
              {result.totalCycles} cycles
            </span>
          </h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <Stat label="Trades" value={summary.totalTrades.toString()} />
          <Stat
            label="Win Rate"
            value={`${(summary.winRate * 100).toFixed(1)}%`}
            sub={`${summary.wins}W / ${summary.losses}L`}
          />
          <Stat
            label="Total P&L"
            value={money(summary.totalPnl)}
            color={pnlColor(summary.totalPnl)}
          />
          <Stat label="Avg R" value={summary.avgR.toFixed(2)} color={pnlColor(summary.avgR)} />
          <Stat
            label="Largest Win"
            value={money(summary.largestWin)}
            color="text-green-700"
          />
          <Stat
            label="Largest Loss"
            value={money(summary.largestLoss)}
            color="text-red-700"
          />
        </div>
      </div>

      <div className="bg-white rounded-lg shadow p-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">
          Equity (start {money(summary.startingEquity)} → end {money(summary.endingEquity)})
        </h3>
        <EquityChart points={equityCurve} startingEquity={summary.startingEquity} />
      </div>

      <div className="bg-white rounded-lg shadow">
        <div className="p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">
            Trades <span className="text-gray-500 font-normal">({closed.length})</span>
          </h3>
        </div>
        {closed.length === 0 ? (
          <div className="p-6 text-gray-500 text-sm">No trades executed</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Symbol</th>
                  <th className="text-right px-3 py-2">Entry</th>
                  <th className="text-right px-3 py-2">Exit</th>
                  <th className="text-right px-3 py-2">Shares</th>
                  <th className="text-right px-3 py-2">P&L</th>
                  <th className="text-right px-3 py-2">R</th>
                  <th className="text-center px-3 py-2">Exit</th>
                  <th className="text-right px-3 py-2">Time (ET)</th>
                </tr>
              </thead>
              <tbody>
                {[...closed]
                  .sort((a, b) =>
                    new Date(b.exitTs ?? 0).getTime() - new Date(a.exitTs ?? 0).getTime(),
                  )
                  .map((t, i) => (
                    <tr key={`${t.symbol}-${i}`} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2 font-semibold">
                        {t.symbol}
                        {t.washSaleFlagged && (
                          <span className="ml-1 text-[10px] px-1 rounded bg-amber-100 text-amber-800">
                            30d
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">${t.entryPrice.toFixed(3)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {t.exitPrice !== undefined ? `$${t.exitPrice.toFixed(3)}` : '--'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{t.shares.toLocaleString()}</td>
                      <td className={`px-3 py-2 text-right tabular-nums font-semibold ${pnlColor(t.pnl ?? 0)}`}>
                        {money(t.pnl ?? 0)}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${pnlColor(t.rMultiple ?? 0)}`}>
                        {(t.rMultiple ?? 0) >= 0 ? '+' : ''}{(t.rMultiple ?? 0).toFixed(1)}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded ${exitReasonBadge(t.exitReason)}`}>
                          {t.exitReason ?? '--'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-500 text-xs">
                        {timeEt(t.entryTs)}→{t.exitTs ? timeEt(t.exitTs) : '--'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {skipped.length > 0 && (
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">
            Skipped candidates <span className="text-gray-500 font-normal">({skipped.length})</span>
          </h3>
          <div className="flex flex-wrap gap-2 text-xs">
            {Object.entries(skippedByReason)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => (
                <span key={reason} className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
                  {reason}: {count}
                </span>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function BacktestPage() {
  const { days, result, isRunning, error, runBacktest } = useBacktest();
  const [selectedDay, setSelectedDay] = useState<string>('');
  const [startingCash, setStartingCash] = useState<string>('10000');

  const effectiveDay = selectedDay || days[0] || '';

  const handleRun = () => {
    if (!effectiveDay) return;
    const cash = Number(startingCash);
    runBacktest(effectiveDay, Number.isFinite(cash) && cash > 0 ? cash : undefined);
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1">
              Trading day
            </label>
            <select
              value={effectiveDay}
              onChange={(e) => setSelectedDay(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm min-w-[150px]"
              disabled={days.length === 0}
            >
              {days.length === 0 ? (
                <option>No recordings available</option>
              ) : (
                days.map((d) => <option key={d} value={d}>{d}</option>)
              )}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1">
              Starting cash
            </label>
            <input
              type="number"
              value={startingCash}
              onChange={(e) => setStartingCash(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm w-32 tabular-nums"
              min={100}
              step={100}
            />
          </div>
          <button
            onClick={handleRun}
            disabled={isRunning || !effectiveDay || days.length === 0}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white px-4 py-1.5 rounded text-sm"
          >
            {isRunning ? 'Running...' : 'Run Backtest'}
          </button>
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
        {days.length === 0 && (
          <div className="mt-2 text-xs text-gray-500">
            No recordings found. Run the server during market hours to capture cycles.
          </div>
        )}
      </div>

      {result && <Results result={result} />}
    </div>
  );
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
