import { TradeCandidate } from '../types';
import { formatPricePrecise, formatPct, setupLabel, scoreColor } from '../utils/format';

interface TradeIdeasPanelProps {
  candidates: TradeCandidate[];
  asOf: string | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
}

export function TradeIdeasPanel({
  candidates,
  asOf,
  isLoading,
  error,
  onRefresh,
}: TradeIdeasPanelProps) {
  return (
    <section className="bg-white rounded-lg shadow mt-6">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Trade Ideas</h2>
          <p className="text-xs text-gray-500">
            Ranked from Oracle structure + message conviction + execution profile
          </p>
        </div>

        <div className="flex items-center gap-3">
          {asOf && (
            <span className="text-xs text-gray-500">
              As of {new Date(asOf).toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={() => {
              void onRefresh();
            }}
            className="bg-gray-800 hover:bg-black text-white text-xs px-2.5 py-1.5 rounded"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-100">{error}</div>
      )}

      {isLoading ? (
        <div className="px-4 py-8 text-sm text-gray-500">Loading trade ideas...</div>
      ) : candidates.length === 0 ? (
        <div className="px-4 py-8 text-sm text-gray-600">
          No trade ideas yet. Symbols can still be synced premarket even when current prices are unavailable.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px]" aria-label="Trade ideas">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Symbol</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Setup</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Score</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Current</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Buy</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Stop</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Sell</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Profit Delta</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Trend</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Mentions</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Rationale</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {candidates.map((candidate) => (
                <tr key={candidate.symbol} className="align-top">
                  <td className="px-4 py-3 text-sm font-semibold text-gray-900">{candidate.symbol}</td>
                  <td className="px-4 py-3 text-sm text-gray-800">{setupLabel(candidate.setup)}</td>
                  <td className="px-4 py-3 text-sm">
                    <span className={`inline-flex px-2 py-1 rounded border text-xs font-semibold ${scoreColor(candidate.score)}`}>
                      {candidate.score.toFixed(2)}
                    </span>
                    <div className="text-[11px] text-gray-500 mt-1">
                      O {candidate.oracleScore.toFixed(0)} / M {candidate.messageScore.toFixed(0)} / E {candidate.executionScore.toFixed(0)}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700">{formatPricePrecise(candidate.snapshot.currentPrice)}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{formatPricePrecise(candidate.snapshot.buyZonePrice)}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{formatPricePrecise(candidate.snapshot.stopPrice)}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{formatPricePrecise(candidate.snapshot.sellZonePrice)}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{formatPct(candidate.snapshot.profitDeltaPct)}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{candidate.snapshot.trend30m ?? '--'}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{candidate.messageContext.mentionCount}</td>
                  <td className="px-4 py-3 text-xs text-gray-600 max-w-[320px]">
                    {candidate.rationale.length > 0 ? candidate.rationale.join(' | ') : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
