import { useCallback, useEffect, useState } from 'react';
import { SignalsSnapshot } from '../types';

const REFRESH_INTERVAL_MS = 5000;

interface UseSignalsResult {
  snapshot: SignalsSnapshot | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useSignals(): UseSignalsResult {
  const [snapshot, setSnapshot] = useState<SignalsSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/signals');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: SignalsSnapshot = await res.json();
      setSnapshot(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load signals');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { snapshot, isLoading, error, refresh };
}
