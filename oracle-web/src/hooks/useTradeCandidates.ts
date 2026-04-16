import { useCallback, useEffect, useRef, useState } from 'react';
import { TradeCandidate } from '../types';

interface TradeCandidatesResponse {
  count: number;
  candidates: TradeCandidate[];
  asOf: string;
}

interface UseTradeCandidatesResult {
  candidates: TradeCandidate[];
  asOf: string | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useTradeCandidates(limit = 12): UseTradeCandidatesResult {
  const [candidates, setCandidates] = useState<TradeCandidate[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/trade-candidates?limit=${Math.max(1, Math.min(limit, 100))}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch candidates (${response.status})`);
      }

      const payload = (await response.json()) as TradeCandidatesResponse;
      setCandidates(payload.candidates ?? []);
      setAsOf(payload.asOf ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch trade candidates');
    } finally {
      setIsLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    refresh();

    // Polling keeps the ideas panel current without requiring a manual page refresh.
    timerRef.current = setInterval(() => {
      refresh();
    }, 15000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [refresh]);

  return {
    candidates,
    asOf,
    isLoading,
    error,
    refresh,
  };
}
