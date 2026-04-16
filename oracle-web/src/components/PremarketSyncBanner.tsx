import { BotStatus, MarketStatus, StockState } from '../types';

interface PremarketSyncBannerProps {
  marketStatus: MarketStatus | null;
  botStatus: BotStatus | null;
  stocks: StockState[];
}

export function PremarketSyncBanner({ marketStatus, botStatus, stocks }: PremarketSyncBannerProps) {
  if (!marketStatus || marketStatus.isOpen) {
    return null;
  }

  const syncedSymbols = botStatus?.symbolCount ?? stocks.length;
  const pricedSymbols = stocks.filter((stock) => stock.currentPrice !== null).length;

  return (
    <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg px-4 py-3 mb-4">
      <div className="font-semibold text-sm">Premarket Mode</div>
      <p className="text-sm mt-1">
        Symbols synced: {syncedSymbols}. Live pricing may remain unavailable until market open.
      </p>
      <p className="text-xs mt-1 text-amber-700">
        Price-ready symbols: {pricedSymbols} / {syncedSymbols}.
      </p>
    </div>
  );
}
