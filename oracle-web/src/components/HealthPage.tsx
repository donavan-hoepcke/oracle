import { Fragment, useEffect, useState } from 'react';
import { useOpsHealth } from '../hooks/useOpsHealth';
import type { ProbeName, ProbeResult, ProbeStatus } from '../types';

const STATUS_LABEL: Record<ProbeStatus, { text: string; class: string }> = {
  ok: { text: 'OK', class: 'bg-green-100 text-green-900' },
  warn: { text: 'WARN', class: 'bg-amber-100 text-amber-900' },
  red: { text: 'RED', class: 'bg-red-100 text-red-900' },
  needs_human: { text: 'NEEDS HUMAN', class: 'bg-red-200 text-red-950 font-bold' },
  unknown: { text: 'UNKNOWN', class: 'bg-gray-100 text-gray-700' },
};

function ageOf(iso: string | null): string {
  if (!iso) return '--';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}

interface HistoryPanelProps {
  probe: ProbeName;
}

function HistoryPanel({ probe }: HistoryPanelProps) {
  const [events, setEvents] = useState<Array<{ ts: string; status: ProbeStatus; message: string }>>([]);
  useEffect(() => {
    void fetch(`/api/ops/health/history?probe=${probe}`)
      .then((r) => r.json())
      .then((d: { events: typeof events }) => setEvents(d.events))
      .catch(() => setEvents([]));
  }, [probe]);
  if (events.length === 0) {
    return <div className="text-xs text-gray-500 italic px-3 py-2">no transitions recorded yet</div>;
  }
  return (
    <ul className="text-xs px-3 py-2 space-y-1">
      {events.slice(-20).reverse().map((e, i) => (
        <li key={i} className="flex gap-3">
          <span className="text-gray-500">{new Date(e.ts).toLocaleTimeString()}</span>
          <span className={`px-1.5 rounded ${STATUS_LABEL[e.status].class}`}>{STATUS_LABEL[e.status].text}</span>
          <span className="text-gray-700">{e.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function HealthPage() {
  const { snapshot, isLoading, error, refresh } = useOpsHealth();
  const [expanded, setExpanded] = useState<ProbeName | null>(null);
  const [resetting, setResetting] = useState(false);

  const reset = async () => {
    setResetting(true);
    try {
      await fetch('/api/ops/health/reset', { method: 'POST' });
      await refresh();
    } finally {
      setResetting(false);
    }
  };

  if (isLoading && !snapshot) return <div className="p-6 text-gray-500">Loading health...</div>;
  if (error && !snapshot) {
    return (
      <div className="p-6">
        <div className="text-red-600 mb-2">{error}</div>
        <button onClick={() => void refresh()} className="bg-blue-600 text-white px-3 py-1.5 rounded text-sm">Retry</button>
      </div>
    );
  }
  if (!snapshot) return <div className="p-6 text-gray-500">No data</div>;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow p-3 flex items-center justify-between">
        <div className="text-sm text-gray-600">
          As of {new Date(snapshot.asOf).toLocaleTimeString()} · {snapshot.probes.length} probe(s)
        </div>
        <button
          type="button"
          onClick={() => void reset()}
          disabled={resetting}
          className="bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
        >
          {resetting ? 'Resetting...' : 'Reset needs_human flags'}
        </button>
      </div>
      <div className="bg-white rounded-lg shadow">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
            <tr>
              <th className="text-left px-3 py-2">Probe</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Last probe</th>
              <th className="text-left px-3 py-2">Last OK</th>
              <th className="text-left px-3 py-2">Failures</th>
              <th className="text-left px-3 py-2">Message</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.probes.map((p: ProbeResult) => (
              <Fragment key={p.name}>
                <tr
                  className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer"
                  onClick={() => setExpanded(expanded === p.name ? null : p.name)}
                >
                  <td className="px-3 py-2 font-mono">{p.name}</td>
                  <td className="px-3 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded ${STATUS_LABEL[p.status].class}`}>
                      {STATUS_LABEL[p.status].text}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-500">{ageOf(p.lastProbeAt)} ago</td>
                  <td className="px-3 py-2 text-gray-500">{p.lastOkAt ? `${ageOf(p.lastOkAt)} ago` : '--'}</td>
                  <td className="px-3 py-2 tabular-nums">{p.consecutiveFailures}</td>
                  <td className="px-3 py-2 text-gray-700 max-w-xl truncate" title={p.message}>{p.message}</td>
                </tr>
                {expanded === p.name && (
                  <tr className="bg-gray-50">
                    <td colSpan={6}><HistoryPanel probe={p.name} /></td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
