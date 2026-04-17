import { config, alpacaApiKeyId, alpacaApiSecretKey } from '../config.js';

const PAPER_BASE = 'https://paper-api.alpaca.markets/v2';
const LIVE_BASE = 'https://api.alpaca.markets/v2';

function baseUrl(): string {
  return config.execution.paper ? PAPER_BASE : LIVE_BASE;
}

function headers(): Record<string, string> {
  return {
    'APCA-API-KEY-ID': alpacaApiKeyId,
    'APCA-API-SECRET-KEY': alpacaApiSecretKey,
    'Content-Type': 'application/json',
  };
}

export interface AlpacaAccount {
  cash: number;
  portfolioValue: number;
  buyingPower: number;
}

export interface AlpacaPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
}

export interface AlpacaOrder {
  id: string;
  symbol: string;
  status: string;
  filledAvgPrice: number | null;
  filledQty: number | null;
}

export interface SubmitOrderParams {
  symbol: string;
  qty: number;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  limitPrice?: number;
}

class AlpacaOrderService {
  async getAccount(): Promise<AlpacaAccount> {
    const res = await fetch(`${baseUrl()}/account`, { headers: headers() });
    if (!res.ok) throw new Error(`Alpaca account error: ${res.status}`);
    const data = await res.json();
    return {
      cash: parseFloat(data.cash),
      portfolioValue: parseFloat(data.portfolio_value),
      buyingPower: parseFloat(data.buying_power),
    };
  }

  async getPositions(): Promise<AlpacaPosition[]> {
    const res = await fetch(`${baseUrl()}/positions`, { headers: headers() });
    if (!res.ok) throw new Error(`Alpaca positions error: ${res.status}`);
    const data = await res.json();
    return data.map((p: Record<string, string>) => ({
      symbol: p.symbol,
      qty: parseFloat(p.qty),
      avgEntryPrice: parseFloat(p.avg_entry_price),
      currentPrice: parseFloat(p.current_price),
      marketValue: parseFloat(p.market_value),
      unrealizedPl: parseFloat(p.unrealized_pl),
    }));
  }

  async submitOrder(params: SubmitOrderParams): Promise<AlpacaOrder> {
    const body: Record<string, string> = {
      symbol: params.symbol,
      qty: String(params.qty),
      side: params.side,
      type: params.type,
      time_in_force: 'day',
    };
    if (params.type === 'limit' && params.limitPrice !== undefined) {
      body.limit_price = String(params.limitPrice);
    }
    const res = await fetch(`${baseUrl()}/orders`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Alpaca order error: ${res.status} ${text}`);
    }
    const data = await res.json();
    return this.mapOrder(data);
  }

  async getOrder(orderId: string): Promise<AlpacaOrder> {
    const res = await fetch(`${baseUrl()}/orders/${orderId}`, { headers: headers() });
    if (!res.ok) throw new Error(`Alpaca getOrder error: ${res.status}`);
    const data = await res.json();
    return this.mapOrder(data);
  }

  async getOpenOrders(): Promise<AlpacaOrder[]> {
    const res = await fetch(`${baseUrl()}/orders?status=open`, { headers: headers() });
    if (!res.ok) throw new Error(`Alpaca getOpenOrders error: ${res.status}`);
    const data = await res.json();
    return data.map((o: Record<string, unknown>) => this.mapOrder(o));
  }

  async cancelOrder(orderId: string): Promise<void> {
    const res = await fetch(`${baseUrl()}/orders/${orderId}`, { method: 'DELETE', headers: headers() });
    if (!res.ok) throw new Error(`Alpaca cancel error: ${res.status}`);
  }

  async closePosition(symbol: string): Promise<void> {
    const res = await fetch(`${baseUrl()}/positions/${symbol}`, { method: 'DELETE', headers: headers() });
    if (!res.ok) throw new Error(`Alpaca closePosition error: ${res.status}`);
  }

  async closeAllPositions(): Promise<void> {
    const res = await fetch(`${baseUrl()}/positions`, { method: 'DELETE', headers: headers() });
    if (!res.ok) throw new Error(`Alpaca closeAll error: ${res.status}`);
  }

  private mapOrder(data: Record<string, unknown>): AlpacaOrder {
    return {
      id: data.id as string,
      symbol: data.symbol as string,
      status: data.status as string,
      filledAvgPrice: data.filled_avg_price ? parseFloat(data.filled_avg_price as string) : null,
      filledQty: data.filled_qty ? parseFloat(data.filled_qty as string) : null,
    };
  }
}

export const alpacaOrderService = new AlpacaOrderService();
