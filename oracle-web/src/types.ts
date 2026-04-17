export type SignalType = 'BRK' | 'RC' | null;

export interface BotStatus {
  isRunning: boolean;
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

export type WebSocketMessage =
  | { type: 'initial'; data: { stocks: StockState[]; marketStatus: MarketStatus; botStatus: BotStatus } }
  | { type: 'watchlist_reload'; data: { stocks: StockState[]; marketStatus: MarketStatus; botStatus: BotStatus } }
  | { type: 'price_update'; data: { stocks: StockState[] } }
  | { type: 'status'; data: { marketStatus: MarketStatus; botStatus: BotStatus } }
  | { type: 'alert'; data: StockState };

export type SetupTag =
  | 'gap_and_go'
  | 'vwap_reclaim'
  | 'first_pullback'
  | 'orb_break'
  | 'red_to_green'
  | 'parabolic_extension'
  | 'news_pop'
  | 'halt_risk';

export interface SymbolMessageContext {
  symbol: string;
  mentionCount: number;
  convictionScore: number;
  tagCounts: Partial<Record<SetupTag, number>>;
  latestMessages: Array<{
    id: string;
    timestamp: string;
    source: string;
    author: string;
    text: string;
    symbols: string[];
    setupTags: SetupTag[];
  }>;
}

export type CandidateSetup =
  | 'red_candle_theory'
  | 'momentum_continuation'
  | 'pullback_reclaim'
  | 'crowded_extension_watch';

export type TrailingState = 'initial' | 'breakeven' | 'trailing';

export type ExitReason = 'stop' | 'trailing_stop' | 'target' | 'eod' | 'circuit_breaker';

export interface ActiveTrade {
  symbol: string;
  strategy: CandidateSetup;
  entryPrice: number;
  entryTime: string;
  shares: number;
  initialStop: number;
  currentStop: number;
  target: number;
  riskPerShare: number;
  status: 'pending' | 'filled' | 'exiting';
  trailingState: TrailingState;
  rationale: string[];
  currentPrice?: number | null;
  unrealizedPl?: number | null;
}

export interface ClosedTrade {
  symbol: string;
  strategy: CandidateSetup;
  entryPrice: number;
  entryTime: string;
  exitPrice: number;
  exitTime: string;
  shares: number;
  pnl: number;
  pnlPct: number;
  rMultiple: number;
  exitReason: ExitReason;
  exitDetail: string;
  rationale: string[];
}

export interface JournalSnapshot {
  account: {
    equity: number;
    cash: number;
    buyingPower: number;
    deployedCapital: number;
    unrealizedPnl: number;
    dailyRealizedPnl: number;
    dailyTotalPnl: number;
  };
  execution: {
    enabled: boolean;
    paper: boolean;
    openPositions: number;
    pendingOrders: number;
    maxPositions: number;
  };
  active: ActiveTrade[];
  closed: ClosedTrade[];
}

export interface TradeCandidate {
  symbol: string;
  score: number;
  setup: CandidateSetup;
  rationale: string[];
  oracleScore: number;
  messageScore: number;
  executionScore: number;
  messageContext: SymbolMessageContext;
  snapshot: {
    currentPrice: number | null;
    buyZonePrice: number | null | undefined;
    stopPrice: number | null | undefined;
    sellZonePrice: number | null | undefined;
    profitDeltaPct: number | null | undefined;
    trend30m: 'up' | 'down' | 'flat' | null;
  };
}
