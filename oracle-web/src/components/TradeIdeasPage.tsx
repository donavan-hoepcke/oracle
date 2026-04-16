import { useMemo, useState } from 'react';
import { TradeCandidate } from '../types';
import { TradeIdeasPanel } from './TradeIdeasPanel';

interface TradeIdeasPageProps {
  candidates: TradeCandidate[];
  asOf: string | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
}

const SETUP_OPTIONS: Array<{ label: string; value: TradeCandidate['setup'] | 'all' }> = [
  { label: 'All Setups', value: 'all' },
  { label: 'Red Candle Theory', value: 'red_candle_theory' },
  { label: 'Momentum Continuation', value: 'momentum_continuation' },
  { label: 'Pullback Reclaim', value: 'pullback_reclaim' },
  { label: 'Crowded Extension Watch', value: 'crowded_extension_watch' },
];

const SETUP_VALUES = SETUP_OPTIONS.map(o => o.value);

export function TradeIdeasPage({
  candidates,
  asOf,
  isLoading,
  error,
  onRefresh,
}: TradeIdeasPageProps) {
  const [setupFilter, setSetupFilter] = useState<TradeCandidate['setup'] | 'all'>('all');
  const [minScore, setMinScore] = useState(0);
  const [minMentions, setMinMentions] = useState(0);
  const [symbolQuery, setSymbolQuery] = useState('');

  const filteredCandidates = useMemo(() => {
    const q = symbolQuery.trim().toUpperCase();

    return candidates.filter((candidate) => {
      if (setupFilter !== 'all' && candidate.setup !== setupFilter) {
        return false;
      }

      if (candidate.score < minScore) {
        return false;
      }

      if (candidate.messageContext.mentionCount < minMentions) {
        return false;
      }

      if (q && !candidate.symbol.includes(q)) {
        return false;
      }

      return true;
    });
  }, [candidates, minMentions, minScore, setupFilter, symbolQuery]);

  return (
    <>
      <section className="bg-white rounded-lg shadow p-4 mb-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm text-gray-700">
            <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Setup</span>
            <select
              className="border border-gray-300 rounded px-2 py-1.5 text-sm"
              value={setupFilter}
              onChange={(event) => {
                const value = event.target.value;
                if (SETUP_VALUES.includes(value as typeof setupFilter)) {
                  setSetupFilter(value as typeof setupFilter);
                }
              }}
            >
              {SETUP_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm text-gray-700">
            <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Min Score</span>
            <input
              type="number"
              className="border border-gray-300 rounded px-2 py-1.5 text-sm w-24"
              min={0}
              max={100}
              value={minScore}
              onChange={(event) => {
                const value = Number.parseFloat(event.target.value);
                setMinScore(Number.isNaN(value) ? 0 : Math.max(0, Math.min(100, value)));
              }}
            />
          </label>

          <label className="text-sm text-gray-700">
            <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Min Mentions</span>
            <input
              type="number"
              className="border border-gray-300 rounded px-2 py-1.5 text-sm w-24"
              min={0}
              value={minMentions}
              onChange={(event) => {
                const value = Number.parseInt(event.target.value, 10);
                setMinMentions(Number.isNaN(value) ? 0 : Math.max(0, value));
              }}
            />
          </label>

          <label className="text-sm text-gray-700">
            <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Symbol</span>
            <input
              type="text"
              className="border border-gray-300 rounded px-2 py-1.5 text-sm w-28"
              placeholder="e.g. WGRX"
              value={symbolQuery}
              onChange={(event) => setSymbolQuery(event.target.value)}
            />
          </label>

          <div className="text-xs text-gray-500 pb-1">Showing {filteredCandidates.length} of {candidates.length}</div>
        </div>
      </section>

      <TradeIdeasPanel
        candidates={filteredCandidates}
        asOf={asOf}
        isLoading={isLoading}
        error={error}
        onRefresh={onRefresh}
      />
    </>
  );
}
