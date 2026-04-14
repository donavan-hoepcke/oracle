import { StockState } from '../types';

interface StockRowProps {
  stock: StockState;
}

export function StockRow({ stock }: StockRowProps) {
  const handleDoubleClick = () => {
    window.open(`https://robinhood.com/stocks/${stock.symbol}`, '_blank');
  };

  const formatPrice = (price: number | null): string => {
    if (price === null) return '--';
    return `$${price.toFixed(2)}`;
  };

  const formatChange = (change: number | null, percent: number | null): string => {
    if (change === null || percent === null) return '--';
    const sign = change >= 0 ? '+' : '';
    return `${sign}${change.toFixed(2)} (${sign}${percent.toFixed(2)}%)`;
  };

  const getChangeColor = (change: number | null): string => {
    if (change === null) return 'text-gray-500';
    if (change > 0) return 'text-green-600';
    if (change < 0) return 'text-red-600';
    return 'text-gray-500';
  };

  const getTrendArrow = (trend30m: 'up' | 'down' | 'flat' | null): { arrow: string; color: string } => {
    if (trend30m === null) return { arrow: '', color: '' };
    if (trend30m === 'up') return { arrow: '▲', color: 'text-green-600' };
    if (trend30m === 'down') return { arrow: '▼', color: 'text-red-600' };
    return { arrow: '–', color: 'text-gray-400' };
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
      onDoubleClick={handleDoubleClick}
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
