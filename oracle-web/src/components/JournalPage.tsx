import { useMemo, useState } from 'react';
import { JournalSnapshot, ActiveTrade, ClosedTrade } from '../types';
import { AccountSummaryCard } from './AccountSummaryCard';
import { DateStrip } from './DateStrip';
import { DaySummaryCard } from './DaySummaryCard';
import { useJournalHistory } from '../hooks/useJournalHistory';

interface JournalPageProps {
  snapshot: JournalSnapshot | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
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

function time(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return '--';
  }
}

function strategyLabel(s: string): string {
  return s
    .split('_')
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(' ');
}

function exitReasonLabel(r: ClosedTrade['exitReason']): string {
  switch (r) {
    case 'stop': return 'Stopped Out';
    case 'trailing_stop': return 'Trailing Stop';
    case 'target': return 'Target Hit';
    case 'eod': return 'EOD Flatten';
    case 'circuit_breaker': return 'Circuit Breaker';
  }
}

function exitReasonBadge(r: ClosedTrade['exitReason']): string {
  switch (r) {
    case 'target': return 'bg-green-100 text-green-800';
    case 'trailing_stop': return 'bg-yellow-100 text-yellow-800';
    case 'stop': return 'bg-red-100 text-red-800';
    case 'eod': return 'bg-gray-100 text-gray-700';
    case 'circuit_breaker': return 'bg-orange-100 text-orange-800';
  }
}

function trailingBadge(s: ActiveTrade['trailingState']): string {
  switch (s) {
    case 'initial': return 'bg-gray-100 text-gray-700';
    case 'mfe_lock': return 'bg-purple-100 text-purple-800';
    case 'breakeven': return 'bg-blue-100 text-blue-800';
    case 'trailing': return 'bg-green-100 text-green-800';
  }
}

function statusBadge(s: ActiveTrade['status']): string {
  switch (s) {
    case 'pending': return 'bg-yellow-100 text-yellow-800';
    case 'filled': return 'bg-green-100 text-green-800';
    case 'exiting': return 'bg-orange-100 text-orange-800';
  }
}

function todayISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function ActiveTradesTable({ active }: { active: ActiveTrade[] }) {
  return (
    <div className="bg-white rounded-lg shadow">
      <div className="p-4 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900">
          Active Trades <span className="text-gray-500 font-normal">({active.length})</span>
        </h2>
      </div>
      {active.length === 0 ? (
        <div className="p-6 text-gray-500 text-sm">No active trades</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Symbol</th>
                <th className="text-left px-3 py-2">Strategy</th>
                <th className="text-right px-3 py-2">Entry</th>
                <th className="text-right px-3 py-2">Stop</th>
                <th className="text-right px-3 py-2">Target</th>
                <th className="text-right px-3 py-2">Current</th>
                <th className="text-right px-3 py-2">Shares</th>
                <th className="text-right px-3 py-2">Unrealized</th>
                <th className="text-center px-3 py-2">State</th>
                <th className="text-center px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Why</th>
              </tr>
            </thead>
            <tbody>
              {active.map((t, i) => {
                const rMult = t.riskPerShare > 0 && t.currentPrice
                  ? (t.currentPrice - t.entryPrice) / t.riskPerShare
                  : 0;
                return (
                  <tr key={`${t.symbol}-${i}`} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2 font-semibold">{t.symbol}</td>
                    <td className="px-3 py-2 text-gray-600">{strategyLabel(t.strategy)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">${t.entryPrice.toFixed(3)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-700">${t.currentStop.toFixed(3)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-green-700">${t.target.toFixed(3)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {t.currentPrice !== null && t.currentPrice !== undefined
                        ? `$${t.currentPrice.toFixed(3)}`
                        : '--'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.shares.toLocaleString()}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${t.unrealizedPl ? pnlColor(t.unrealizedPl) : ''}`}>
                      {t.unrealizedPl !== null && t.unrealizedPl !== undefined
                        ? `${money(t.unrealizedPl)} (${rMult >= 0 ? '+' : ''}${rMult.toFixed(1)}R)`
                        : '--'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`text-xs px-2 py-0.5 rounded ${trailingBadge(t.trailingState)}`}>
                        {t.trailingState}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`text-xs px-2 py-0.5 rounded ${statusBadge(t.status)}`}>
                        {t.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-600 text-xs max-w-md">
                      {t.rationale.length > 0 ? (
                        <ul className="space-y-0.5">
                          {t.rationale.slice(0, 3).map((r, j) => (
                            <li key={j}>• {r}</li>
                          ))}
                          {t.rationale.length > 3 && (
                            <li className="text-gray-400">+{t.rationale.length - 3} more</li>
                          )}
                        </ul>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ClosedTradesTable({ closed, isToday }: { closed: ClosedTrade[]; isToday: boolean }) {
  return (
    <div className="bg-white rounded-lg shadow">
      <div className="p-4 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900">
          Closed Trades <span className="text-gray-500 font-normal">({closed.length})</span>
        </h2>
      </div>
      {closed.length === 0 ? (
        <div className="p-6 text-gray-500 text-sm">
          {isToday ? 'No closed trades yet today' : 'No closed trades recorded on this day'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Symbol</th>
                <th className="text-left px-3 py-2">Strategy</th>
                <th className="text-right px-3 py-2">Entry</th>
                <th className="text-right px-3 py-2">Exit</th>
                <th className="text-right px-3 py-2">P&L</th>
                <th className="text-right px-3 py-2">R</th>
                <th className="text-center px-3 py-2">Exit</th>
                <th className="text-left px-3 py-2">Detail</th>
                <th className="text-right px-3 py-2">Time</th>
              </tr>
            </thead>
            <tbody>
              {[...closed]
                .sort((a, b) => new Date(b.exitTime).getTime() - new Date(a.exitTime).getTime())
                .map((t, i) => (
                  <tr key={`${t.symbol}-${i}-${t.exitTime}`} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2 font-semibold">{t.symbol}</td>
                    <td className="px-3 py-2 text-gray-600">{strategyLabel(t.strategy)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">${t.entryPrice.toFixed(3)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">${t.exitPrice.toFixed(3)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-semibold ${pnlColor(t.pnl)}`}>
                      {money(t.pnl)}
                      <span className="text-xs text-gray-500 ml-1">
                        ({t.pnlPct >= 0 ? '+' : ''}{t.pnlPct.toFixed(1)}%)
                      </span>
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pnlColor(t.rMultiple)}`}>
                      {t.rMultiple >= 0 ? '+' : ''}{t.rMultiple.toFixed(1)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`text-xs px-2 py-0.5 rounded ${exitReasonBadge(t.exitReason)}`}>
                        {exitReasonLabel(t.exitReason)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-600 text-xs max-w-md">{t.exitDetail}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-500 text-xs">
                      {time(t.entryTime)}→{time(t.exitTime)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function JournalPage({ snapshot, isLoading, error, onRefresh }: JournalPageProps) {
  const today = useMemo(todayISO, []);
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const isToday = selectedDate === today;
  const { days, historyDay, isLoading: historyLoading, error: historyError } = useJournalHistory(
    isToday ? null : selectedDate,
  );

  const stripDays = useMemo(() => {
    const set = new Set<string>([today, ...days]);
    if (!set.has(selectedDate)) set.add(selectedDate);
    return [...set].sort((a, b) => b.localeCompare(a));
  }, [days, selectedDate, today]);

  const strip = (
    <DateStrip
      days={stripDays}
      selected={selectedDate}
      today={today}
      onSelect={setSelectedDate}
    />
  );

  if (isToday) {
    if (isLoading && !snapshot) {
      return (
        <div className="space-y-6">
          {strip}
          <div className="p-6 text-gray-500">Loading journal...</div>
        </div>
      );
    }
    if (error && !snapshot) {
      return (
        <div className="space-y-6">
          {strip}
          <div className="p-6">
            <div className="text-red-600 mb-2">Failed to load journal: {error}</div>
            <button
              onClick={onRefresh}
              className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    if (!snapshot) {
      return (
        <div className="space-y-6">
          {strip}
          <div className="p-6 text-gray-500">No data</div>
        </div>
      );
    }

    const { execution, active, closed } = snapshot;
    return (
      <div className="space-y-6">
        {strip}
        <AccountSummaryCard snapshot={snapshot} onRefresh={onRefresh} />
        <DaySummaryCard
          date={today}
          closed={closed}
          isToday
          openPositions={execution.openPositions}
        />
        <ActiveTradesTable active={active} />
        <ClosedTradesTable closed={closed} isToday />
      </div>
    );
  }

  if (historyLoading && !historyDay) {
    return (
      <div className="space-y-6">
        {strip}
        <div className="p-6 text-gray-500">Loading {selectedDate}...</div>
      </div>
    );
  }
  if (historyError) {
    return (
      <div className="space-y-6">
        {strip}
        <div className="p-6">
          <div className="text-red-600 mb-2">Failed to load {selectedDate}: {historyError}</div>
          <button
            onClick={() => setSelectedDate(today)}
            className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm"
          >
            Back to Today
          </button>
        </div>
      </div>
    );
  }
  if (!historyDay) {
    return (
      <div className="space-y-6">
        {strip}
        <div className="p-6 text-gray-500">No data for {selectedDate}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {strip}
      <DaySummaryCard
        date={historyDay.date}
        closed={historyDay.closed}
        isToday={false}
        lastCycleAt={historyDay.lastCycleAt}
      />
      <ClosedTradesTable closed={historyDay.closed} isToday={false} />
    </div>
  );
}
