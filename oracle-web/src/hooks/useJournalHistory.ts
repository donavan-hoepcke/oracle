import { useCallback, useEffect, useState } from 'react';
import { JournalHistoryDay } from '../types';

interface UseJournalHistoryResult {
  days: string[];
  historyDay: JournalHistoryDay | null;
  isLoading: boolean;
  error: string | null;
  refreshDays: () => Promise<void>;
}

export function useJournalHistory(selectedDate: string | null): UseJournalHistoryResult {
  const [days, setDays] = useState<string[]>([]);
  const [historyDay, setHistoryDay] = useState<JournalHistoryDay | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshDays = useCallback(async () => {
    try {
      const res = await fetch('/api/journal/days');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { days: string[] } = await res.json();
      setDays(data.days);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load journal days');
    }
  }, []);

  useEffect(() => {
    refreshDays();
  }, [refreshDays]);

  useEffect(() => {
    if (!selectedDate) {
      setHistoryDay(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    fetch(`/api/journal/history/${selectedDate}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<JournalHistoryDay>;
      })
      .then((data) => {
        if (!cancelled) setHistoryDay(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load history');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDate]);

  return { days, historyDay, isLoading, error, refreshDays };
}
