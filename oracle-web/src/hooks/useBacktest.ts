import { useCallback, useEffect, useState } from 'react';
import { BacktestResult } from '../types';

interface UseBacktestResult {
  days: string[];
  result: BacktestResult | null;
  isRunning: boolean;
  error: string | null;
  loadDays: () => Promise<void>;
  runBacktest: (tradingDay: string, startingCash?: number) => Promise<void>;
}

export function useBacktest(): UseBacktestResult {
  const [days, setDays] = useState<string[]>([]);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDays = useCallback(async () => {
    try {
      const res = await fetch('/api/backtest/days');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { days: string[] } = await res.json();
      setDays(data.days);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load recording days');
    }
  }, []);

  const runBacktest = useCallback(
    async (tradingDay: string, startingCash?: number) => {
      setIsRunning(true);
      setError(null);
      try {
        const res = await fetch('/api/backtest/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tradingDay, startingCash }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const data: BacktestResult = await res.json();
        setResult(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Backtest failed');
      } finally {
        setIsRunning(false);
      }
    },
    [],
  );

  useEffect(() => {
    loadDays();
  }, [loadDays]);

  return { days, result, isRunning, error, loadDays, runBacktest };
}
