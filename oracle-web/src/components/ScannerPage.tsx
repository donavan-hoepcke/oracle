import { FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ScannerRow, ScannerSnapshot, ScannerStatus } from '../types';
import { ZoneBar } from './ZoneBar';

interface ScannerPageProps {
  snapshot: ScannerSnapshot | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
}

const STATUS_ORDER: Record<ScannerStatus, number> = {
  traded: 0,
  rejected: 1,
  candidate: 2,
  setup: 3,
  blown_out: 4,
  watch: 5,
  dead: 6,
};

const STATUS_BADGES: Record<ScannerStatus, { label: string; classes: string }> = {
  traded: { label: 'TRADED', classes: 'bg-green-600 text-white' },
  rejected: { label: 'REJECTED', classes: 'bg-yellow-200 text-yellow-900' },
  candidate: { label: 'CANDIDATE', classes: 'bg-blue-600 text-white' },
  setup: { label: 'SETUP', classes: 'bg-blue-200 text-blue-900' },
  blown_out: { label: 'BLOWN OUT', classes: 'bg-purple-200 text-purple-900' },
  watch: { label: 'WATCH', classes: 'bg-gray-200 text-gray-700' },
  dead: { label: 'DEAD', classes: 'bg-red-200 text-red-900' },
};

function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined) return '--';
  return `$${v.toFixed(3)}`;
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '--';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function pctColor(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'text-gray-400';
  if (v > 0.2) return 'text-green-700';
  if (v < -0.2) return 'text-red-700';
  return 'text-gray-600';
}

function strategyLabel(s: string): string {
  return s
    .split('_')
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(' ');
}

function rowWhy(row: ScannerRow): string {
  if (row.activeTrade) {
    const r = row.activeTrade.rMultiple;
    const rText = r !== null ? ` (${r >= 0 ? '+' : ''}${r.toFixed(1)}R)` : '';
    return `Bot is trading this. ${strategyLabel(row.activeTrade.trailingState)} stop${rText}.`;
  }
  if (row.cooldownExpiresAt) {
    const mins = Math.max(0, Math.round((new Date(row.cooldownExpiresAt).getTime() - Date.now()) / 60000));
    return `Cooldown: re-entry blocked for ~${mins}m after prior stop exit.`;
  }
  if (row.rejection) {
    return `Rejected: ${row.rejection.reason}. (${strategyLabel(row.rejection.setup)} score ${row.rejection.score.toFixed(0)})`;
  }
  if (row.candidate) {
    return `Candidate: ${strategyLabel(row.candidate.setup)} score ${row.candidate.score.toFixed(0)}`;
  }
  switch (row.status) {
    case 'setup':
      return 'Price is in the buy zone. Rule engine has not flagged a setup yet.';
    case 'blown_out':
      return 'Price is already past the sell zone — entry opportunity missed.';
    case 'dead':
      return 'Price is at/below stop. Will not trade today.';
    case 'watch':
    default:
      return 'Waiting for price to reach buy zone.';
  }
}

const ALL_STATUSES: ScannerStatus[] = ['traded', 'rejected', 'candidate', 'setup', 'blown_out', 'watch', 'dead'];

export function ScannerPage({ snapshot, isLoading, error, onRefresh }: ScannerPageProps) {
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<ScannerStatus>>(new Set(['dead']));
  const [sortKey, setSortKey] = useState<'default' | 'pctChange' | 'pctToBuy'>('default');
  const [lookup, setLookup] = useState('');
  const navigate = useNavigate();

  const submitLookup = (e: FormEvent) => {
    e.preventDefault();
    const sym = lookup.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(sym)) return;
    navigate(`/symbol/${sym}`);
    setLookup('');
  };

  const toggleStatus = (s: ScannerStatus) => {
    setHiddenStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const filteredRows = useMemo(() => {
    if (!snapshot) return [];
    const rows = snapshot.rows.filter((r) => !hiddenStatuses.has(r.status));

    if (sortKey === 'pctChange') {
      rows.sort((a, b) => (b.changePercent ?? -Infinity) - (a.changePercent ?? -Infinity));
    } else if (sortKey === 'pctToBuy') {
      rows.sort((a, b) => Math.abs(a.pctToBuyZone ?? 999) - Math.abs(b.pctToBuyZone ?? 999));
    } else {
      rows.sort((a, b) => {
        const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        if (so !== 0) return so;
        if (a.status === 'traded' && b.status === 'traded') {
          return (b.activeTrade?.rMultiple ?? 0) - (a.activeTrade?.rMultiple ?? 0);
        }
        if (a.status === 'candidate' || a.status === 'rejected') {
          const sa = a.candidate?.score ?? a.rejection?.score ?? 0;
          const sb = b.candidate?.score ?? b.rejection?.score ?? 0;
          return sb - sa;
        }
        if (a.status === 'setup' || a.status === 'watch') {
          return Math.abs(a.pctToBuyZone ?? 999) - Math.abs(b.pctToBuyZone ?? 999);
        }
        return 0;
      });
    }

    return rows;
  }, [snapshot, hiddenStatuses, sortKey]);

  if (isLoading && !snapshot) {
    return <div className="p-6 text-gray-500">Loading scanner...</div>;
  }
  if (error && !snapshot) {
    return (
      <div className="p-6">
        <div className="text-red-600 mb-2">Failed to load scanner: {error}</div>
        <button onClick={onRefresh} className="bg-blue-600 text-white px-3 py-1.5 rounded text-sm">
          Retry
        </button>
      </div>
    );
  }
  if (!snapshot) return <div className="p-6 text-gray-500">No data</div>;

  const counts: Record<ScannerStatus, number> = {
    traded: 0, rejected: 0, candidate: 0, setup: 0, blown_out: 0, watch: 0, dead: 0,
  };
  for (const r of snapshot.rows) counts[r.status]++;

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="bg-white rounded-lg shadow p-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide mr-1">Show</span>
        {ALL_STATUSES.map((s) => {
          const hidden = hiddenStatuses.has(s);
          const badge = STATUS_BADGES[s];
          return (
            <button
              key={s}
              onClick={() => toggleStatus(s)}
              className={`text-xs px-2 py-0.5 rounded border transition ${
                hidden
                  ? 'bg-white text-gray-400 border-gray-200 line-through'
                  : `${badge.classes} border-transparent`
              }`}
            >
              {badge.label} {counts[s]}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-2">
          <form onSubmit={submitLookup} className="flex items-center gap-1">
            <input
              type="text"
              placeholder="Lookup ticker"
              value={lookup}
              onChange={(e) => setLookup(e.target.value)}
              className="border border-gray-300 rounded px-2 py-0.5 text-xs uppercase w-28"
              maxLength={10}
            />
            <button
              type="submit"
              className="text-xs px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-700"
            >
              Go
            </button>
          </form>
          <span className="text-xs text-gray-500">Sort</span>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as typeof sortKey)}
            className="border border-gray-300 rounded px-2 py-0.5 text-xs"
          >
            <option value="default">By Status</option>
            <option value="pctChange">% Change</option>
            <option value="pctToBuy">Distance to Buy Zone</option>
          </select>
        </div>
      </div>

      {/* Scanner table */}
      <div className="bg-white rounded-lg shadow">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Symbol</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-right px-3 py-2">Current</th>
                <th className="text-right px-3 py-2">% Day</th>
                <th className="text-left px-3 py-2 min-w-[200px]">Zone</th>
                <th className="text-right px-3 py-2">% to Buy</th>
                <th className="text-right px-3 py-2">% to Sell</th>
                <th className="text-center px-3 py-2">Sig</th>
                <th className="text-left px-3 py-2">Why</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => {
                const badge = STATUS_BADGES[r.status];
                return (
                  <tr key={r.symbol} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2 font-semibold">
                      <Link
                        to={`/symbol/${r.symbol}`}
                        className="text-blue-700 hover:underline"
                      >
                        {r.symbol}
                      </Link>
                      {r.washSaleRisk && (
                        <span
                          className="ml-1 text-[10px] px-1 rounded bg-amber-100 text-amber-800"
                          title="Traded in last 30 days — tighter entry bar applies (wash-sale awareness)"
                        >
                          30d
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded font-semibold ${badge.classes}`}>
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtPrice(r.currentPrice)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pctColor(r.changePercent)}`}>
                      {fmtPct(r.changePercent)}
                    </td>
                    <td className="px-3 py-2">
                      <ZoneBar
                        stop={r.stopPrice}
                        buy={r.buyZonePrice}
                        sell={r.sellZonePrice}
                        current={r.currentPrice}
                        entry={r.activeTrade?.entryPrice ?? null}
                      />
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pctColor(r.pctToBuyZone)}`}>
                      {fmtPct(r.pctToBuyZone)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pctColor(r.pctToSellZone)}`}>
                      {fmtPct(r.pctToSellZone)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {r.signal ? (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 font-semibold">
                          {r.signal}
                        </span>
                      ) : (
                        <span className="text-gray-300 text-xs">·</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-600 text-xs max-w-md">{rowWhy(r)}</td>
                  </tr>
                );
              })}
              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-gray-500">
                    No rows match current filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
