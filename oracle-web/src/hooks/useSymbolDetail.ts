import { useCallback, useEffect, useState } from 'react';
import { SymbolDetail } from '../types';

const REFRESH_INTERVAL_MS = 5000;

interface UseSymbolDetailResult {
  detail: SymbolDetail | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useSymbolDetail(symbol: string | undefined): UseSymbolDetailResult {
  const [detail, setDetail] = useState<SymbolDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!symbol) return;
    try {
      const res = await fetch(`/api/symbol/${encodeURIComponent(symbol)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data: SymbolDetail = await res.json();
      setDetail(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load symbol detail');
    } finally {
      setIsLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    setDetail(null);
    setIsLoading(true);
    if (!symbol) return;
    refresh();
    const id = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [symbol, refresh]);

  return { detail, isLoading, error, refresh };
}
