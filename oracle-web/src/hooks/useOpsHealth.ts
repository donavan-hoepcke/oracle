import { useEffect, useState, useCallback } from 'react';
import type { OpsHealthSnapshot } from '../types';

interface UseOpsHealthResult {
  snapshot: OpsHealthSnapshot | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useOpsHealth(): UseOpsHealthResult {
  const [snapshot, setSnapshot] = useState<OpsHealthSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/api/ops/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as OpsHealthSnapshot;
      setSnapshot(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load ops health');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial fetch + WS subscription. The WS keeps the snapshot live;
  // refresh() is exposed for the manual retry button on the Health page.
  useEffect(() => {
    void refresh();
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/api/raw/stream`);
    ws.addEventListener('message', (evt) => {
      try {
        const data = JSON.parse(evt.data) as { type?: string; payload?: OpsHealthSnapshot };
        if (data.type === 'ops_health' && data.payload) {
          setSnapshot(data.payload);
        }
      } catch {
        // ignore malformed messages
      }
    });
    return () => ws.close();
  }, [refresh]);

  return { snapshot, isLoading, error, refresh };
}
