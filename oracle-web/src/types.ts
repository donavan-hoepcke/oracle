export type SignalType = 'BRK' | 'RC' | null;
export type TickerSourceMode = 'excel' | 'playwright';

export interface BotStatus {
  isRunning: boolean;
  source: TickerSourceMode;
  lastSync: string | null;
  symbolCount: number;
  lastError: string | null;
}

export interface StockState {
  symbol: string;
  targetPrice: number;
  resistance: number | null;
  currentPrice: number | null;
  change: number | null;
  changePercent: number | null;
  trend30m: 'up' | 'down' | 'flat' | null;
  inTargetRange: boolean;
  alerted: boolean;
  source: string;
  lastUpdate: string | null;
  signal: SignalType;
  boxTop: number | null;
  boxBottom: number | null;
  signalTimestamp: string | null;
}

export interface MarketStatus {
  isOpen: boolean;
  currentTime: string;
  openTime: string;
  closeTime: string;
  nextChange: string;
}

export interface WebSocketMessage {
  type: 'price_update' | 'alert' | 'status' | 'watchlist_reload' | 'initial';
  data: {
    stocks?: StockState[];
    marketStatus?: MarketStatus;
    botStatus?: BotStatus;
  } | StockState;
}
