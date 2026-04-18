import { useCallback, useEffect, useState } from 'react';
import { BacktestResult } from '../types';

export interface SynthResult {
  filePath: string;
  day: string;
  tickers: string[];
  cyclesWritten: number;
  seed: number;
  outcomes: { win: number; loss: number; chop: number };
}

interface UseBacktestResult {
  days: string[];
  result: BacktestResult | null;
  isRunning: boolean;
  error: string | null;
  loadDays: () => Promise<void>;
  runBacktest: (tradingDay: string, startingCash?: number, riskPerTrade?: number) => Promise<void>;
  synthDay: (day: string, tickers?: string[], seed?: number) => Promise<SynthResult | null>;
  isSynthing: boolean;
  synthError: string | null;
  lastSynth: SynthResult | null;
}

export function useBacktest(): UseBacktestResult {
  const [days, setDays] = useState<string[]>([]);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSynthing, setIsSynthing] = useState(false);
  const [synthError, setSynthError] = useState<string | null>(null);
  const [lastSynth, setLastSynth] = useState<SynthResult | null>(null);

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
    async (tradingDay: string, startingCash?: number, riskPerTrade?: number) => {
      setIsRunning(true);
      setError(null);
      try {
        const body: { tradingDay: string; startingCash?: number; riskPerTrade?: number } = {
          tradingDay,
        };
        if (typeof startingCash === 'number') body.startingCash = startingCash;
        if (typeof riskPerTrade === 'number') body.riskPerTrade = riskPerTrade;
        const res = await fetch('/api/backtest/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
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

  const synthDay = useCallback(
    async (day: string, tickers?: string[], seed?: number): Promise<SynthResult | null> => {
      setIsSynthing(true);
      setSynthError(null);
      try {
        const body: { day: string; tickers?: string[]; seed?: number } = { day };
        if (tickers && tickers.length > 0) body.tickers = tickers;
        if (typeof seed === 'number') body.seed = seed;
        const res = await fetch('/api/backtest/synth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload.error ?? `HTTP ${res.status}`);
        }
        const data: SynthResult = await res.json();
        setLastSynth(data);
        await loadDays();
        return data;
      } catch (err) {
        setSynthError(err instanceof Error ? err.message : 'Synth failed');
        return null;
      } finally {
        setIsSynthing(false);
      }
    },
    [loadDays],
  );

  useEffect(() => {
    loadDays();
  }, [loadDays]);

  return {
    days,
    result,
    isRunning,
    error,
    loadDays,
    runBacktest,
    synthDay,
    isSynthing,
    synthError,
    lastSynth,
  };
}
