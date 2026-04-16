import { useEffect, useRef, useState, useCallback } from 'react';
import { StockState, MarketStatus, WebSocketMessage, BotStatus } from '../types';

interface UseWebSocketResult {
  stocks: StockState[];
  marketStatus: MarketStatus | null;
  botStatus: BotStatus | null;
  isConnected: boolean;
  lastUpdate: Date | null;
  alerts: StockState[];
  clearAlert: (symbol: string) => void;
}

export function useWebSocket(): UseWebSocketResult {
  const [stocks, setStocks] = useState<StockState[]>([]);
  const [marketStatus, setMarketStatus] = useState<MarketStatus | null>(null);
  const [botStatus, setBotStatus] = useState<BotStatus | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [alerts, setAlerts] = useState<StockState[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAlert = useCallback((symbol: string) => {
    setAlerts((prev) => prev.filter((a) => a.symbol !== symbol));
  }, []);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    console.log('Connecting to WebSocket:', wsUrl);
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('WebSocket connected');
      setIsConnected(true);
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setIsConnected(false);

      // Attempt reconnect after 3 seconds
      reconnectTimeoutRef.current = setTimeout(() => {
        console.log('Attempting reconnect...');
        connect();
      }, 3000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.onmessage = (event) => {
      try {
        const message: WebSocketMessage = JSON.parse(event.data);
        handleMessage(message);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    wsRef.current = ws;
  }, []);

  const handleMessage = useCallback((message: WebSocketMessage) => {
    switch (message.type) {
      case 'initial':
      case 'watchlist_reload': {
        const { stocks, marketStatus: ms, botStatus: bs } = message.data;
        setStocks(stocks);
        setMarketStatus(ms);
        setBotStatus(bs);
        setLastUpdate(new Date());
        if (message.type === 'watchlist_reload') {
          setAlerts([]);
        }
        break;
      }

      case 'price_update': {
        const { stocks: updatedStocks } = message.data;
        setStocks((prevStocks) => {
          const stockMap = new Map(prevStocks.map((s) => [s.symbol, s]));
          for (const updated of updatedStocks) {
            stockMap.set(updated.symbol, updated);
          }
          return Array.from(stockMap.values());
        });
        setLastUpdate(new Date());
        break;
      }

      case 'status': {
        const { marketStatus: ms, botStatus: bs } = message.data;
        setMarketStatus(ms);
        setBotStatus(bs);
        break;
      }

      case 'alert': {
        const alertStock = message.data;
        setAlerts((prev) => {
          if (prev.some((a) => a.symbol === alertStock.symbol)) {
            return prev;
          }
          return [...prev, alertStock];
        });
        break;
      }
    }
  }, []);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  return {
    stocks,
    marketStatus,
    botStatus,
    isConnected,
    lastUpdate,
    alerts,
    clearAlert,
  };
}
