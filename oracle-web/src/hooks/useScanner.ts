import { useEffect, useState, useCallback } from 'react';
import { ScannerSnapshot } from '../types';

const REFRESH_INTERVAL_MS = 5000;

interface UseScannerResult {
  snapshot: ScannerSnapshot | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useScanner(): UseScannerResult {
  const [snapshot, setSnapshot] = useState<ScannerSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/scanner');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ScannerSnapshot = await res.json();
      setSnapshot(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load scanner');
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
