import { StockState } from '../types';
import { formatPrice, formatChange, getChangeColor, getTrendArrow, robinhoodUrl } from '../utils/format';

interface StockRowProps {
  stock: StockState;
}

export function StockRow({ stock }: StockRowProps) {
  const openRobinhood = () => {
    window.open(robinhoodUrl(stock.symbol), '_blank');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openRobinhood();
    }
  };

  const getSignalBadge = (signal: 'BRK' | 'RC' | null) => {
    if (signal === 'BRK') {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
          BRK
        </span>
      );
    }
    if (signal === 'RC') {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
          RC
        </span>
      );
    }
    return <span className="text-gray-400 text-xs">--</span>;
  };

  const trend = getTrendArrow(stock.trend30m);

  const threshold = 0.03; // 3%
  const hasTarget = stock.targetPrice > 0;
  const lowerBound = hasTarget ? stock.targetPrice * (1 - threshold) : null;
  const upperBound = hasTarget ? stock.targetPrice * (1 + threshold) : null;

  return (
    <tr
      onDoubleClick={openRobinhood}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="row"
      aria-label={`${stock.symbol} - ${stock.currentPrice !== null ? `$${stock.currentPrice.toFixed(2)}` : 'no price'}`}
      className={`border-b border-gray-200 cursor-pointer hover:bg-gray-50 transition-colors ${
        stock.inTargetRange ? 'bg-green-200 hover:bg-green-300' : ''
      }`}
    >
      <td className="px-4 py-3 font-semibold text-blue-600">
        {stock.symbol}
      </td>
      <td className="px-4 py-3 text-right font-mono">
        {hasTarget ? (
          <>
            <div>{formatPrice(stock.targetPrice)}</div>
            <div className="text-xs text-gray-400">
              {formatPrice(lowerBound)} - {formatPrice(upperBound)}
            </div>
          </>
        ) : (
          <div className="text-sm text-gray-400">N/A</div>
        )}
      </td>
      <td className="px-4 py-3 text-right font-mono font-semibold">
        {formatPrice(stock.currentPrice)}
      </td>
      <td className="px-4 py-3 text-right font-mono text-gray-600">
        {formatPrice(stock.resistance)}
      </td>
      <td className={`px-4 py-3 text-right font-mono ${getChangeColor(stock.change)}`}>
        {formatChange(stock.change, stock.changePercent)}
      </td>
      <td className={`px-4 py-3 text-center text-lg ${trend.color}`}>
        {trend.arrow || '--'}
      </td>
      <td className="px-4 py-3 text-center">
        {getSignalBadge(stock.signal)}
      </td>
      <td className="px-4 py-3 text-center">
        {stock.inTargetRange ? (
          <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
            IN RANGE
          </span>
        ) : stock.currentPrice !== null ? (
          <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
            Watching
          </span>
        ) : (
          <span className="text-gray-400 text-xs">--</span>
        )}
      </td>
      <td className="px-4 py-3 text-center text-xs text-gray-400">
        {stock.source || '--'}
      </td>
    </tr>
  );
}
