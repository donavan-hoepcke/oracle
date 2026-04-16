import { StockState } from '../types';
import { StockRow } from './StockRow';

interface StockTableProps {
  stocks: StockState[];
}

export function StockTable({ stocks }: StockTableProps) {
  if (stocks.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        <div className="text-center">
          <p className="text-lg">No stocks in watchlist</p>
          <p className="text-sm mt-2">
            Load symbols from Excel or start the Playwright ticker source
          </p>
        </div>
      </div>
    );
  }

  // Sort stocks: in-range first, then alphabetically
  const sortedStocks = [...stocks].sort((a, b) => {
    if (a.inTargetRange && !b.inTargetRange) return -1;
    if (!a.inTargetRange && b.inTargetRange) return 1;
    return a.symbol.localeCompare(b.symbol);
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full" aria-label="Stock watchlist">
        <thead className="bg-gray-100">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
              Ticker
            </th>
            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">
              Target Range
            </th>
            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">
              Current Price
            </th>
            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">
              Resistance
            </th>
            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">
              Change
            </th>
            <th className="px-4 py-3 text-center text-xs font-semibold text-gray-600 uppercase tracking-wider">
              30 Min. Trend
            </th>
            <th className="px-4 py-3 text-center text-xs font-semibold text-gray-600 uppercase tracking-wider">
              Signal
            </th>
            <th className="px-4 py-3 text-center text-xs font-semibold text-gray-600 uppercase tracking-wider">
              Status
            </th>
            <th className="px-4 py-3 text-center text-xs font-semibold text-gray-600 uppercase tracking-wider">
              Source
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {sortedStocks.map((stock) => (
            <StockRow key={stock.symbol} stock={stock} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
