import { useNavigate } from 'react-router-dom';
import type { OpsHealthSnapshot, ProbeStatus, ProbeResult } from '../types';

const RANK: Record<ProbeStatus, number> = {
  ok: 0,
  unknown: 1,
  warn: 2,
  red: 3,
  needs_human: 4,
};

export function worstOf(statuses: ProbeStatus[]): ProbeStatus {
  if (statuses.length === 0) return 'unknown';
  return statuses.reduce<ProbeStatus>(
    (worst, s) => (RANK[s] > RANK[worst] ? s : worst),
    'ok',
  );
}

const DOT_CLASS: Record<ProbeStatus, string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-400',
  red: 'bg-red-500',
  needs_human: 'bg-red-800',
  unknown: 'bg-gray-400',
};

interface OpsHealthDotsProps {
  snapshot: OpsHealthSnapshot | null;
}

export function OpsHealthDots({ snapshot }: OpsHealthDotsProps) {
  const navigate = useNavigate();
  if (!snapshot) {
    return <span className="w-2 h-2 rounded-full bg-gray-400" aria-label="ops health: unknown" />;
  }
  const rollup = worstOf(snapshot.probes.map((p) => p.status));
  return (
    <button
      type="button"
      className="flex items-center gap-1 hover:opacity-80"
      title="Click for system health"
      onClick={() => navigate('/health')}
    >
      <span
        className={`w-2 h-2 rounded-full ${DOT_CLASS[rollup]}`}
        aria-label={`ops health: ${rollup}`}
      />
      {snapshot.probes.map((p: ProbeResult) => (
        <span
          key={p.name}
          className={`w-1.5 h-1.5 rounded-full ${DOT_CLASS[p.status]}`}
          title={`${p.name}: ${p.status} — ${p.message}`}
          aria-label={`${p.name}: ${p.status}`}
        />
      ))}
    </button>
  );
}
