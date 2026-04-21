import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { SignalInboxItem, SignalKind, SignalsSnapshot } from '../types';

interface SignalsPageProps {
  snapshot: SignalsSnapshot | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
}

const KIND_ORDER: SignalKind[] = ['moderator_primary', 'candidate', 'moderator_backup', 'community_hot'];

const KIND_META: Record<SignalKind, { label: string; classes: string }> = {
  moderator_primary: { label: 'MOD ALERT', classes: 'bg-blue-600 text-white' },
  candidate: { label: 'CANDIDATE', classes: 'bg-indigo-600 text-white' },
  moderator_backup: { label: 'MOD BACKUP', classes: 'bg-blue-200 text-blue-900' },
  community_hot: { label: 'COMMUNITY', classes: 'bg-amber-200 text-amber-900' },
};

function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined) return '--';
  return `$${v.toFixed(3)}`;
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

function strategyLabel(s: string): string {
  return s.split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
}

function ItemDetails({ item }: { item: SignalInboxItem }) {
  const d = item.details;
  const bits: React.ReactNode[] = [];

  if (item.kind === 'candidate') {
    bits.push(
      <span key="score">
        Score <strong>{d.score?.toFixed(0)}</strong>
        {d.setup && <span className="text-gray-500"> · {strategyLabel(d.setup)}</span>}
      </span>,
    );
    if (d.suggestedEntry !== undefined) {
      bits.push(
        <span key="entry">
          Entry {fmtPrice(d.suggestedEntry)} / Stop {fmtPrice(d.suggestedStop)} / Target{' '}
          {fmtPrice(d.suggestedTarget)}
        </span>,
      );
    }
    if (d.rationale && d.rationale.length > 0) {
      bits.push(
        <span key="rationale" className="text-gray-500">
          {d.rationale.slice(0, 2).join(' · ')}
        </span>,
      );
    }
  } else if (item.kind === 'moderator_primary') {
    bits.push(
      <span key="primary">
        Signal <strong>{fmtPrice(d.signal ?? null)}</strong> · Risk{' '}
        {fmtPrice(d.riskZone ?? null)} · Target {d.target ?? '--'}
      </span>,
    );
    bits.push(
      <span key="author" className="text-gray-500">
        {d.author} · {d.postTitle}
      </span>,
    );
  } else if (item.kind === 'moderator_backup') {
    if (d.note) bits.push(<span key="note">{d.note}</span>);
    bits.push(
      <span key="price" className="text-gray-600">
        {fmtPrice(d.signal ?? null)}
      </span>,
    );
    bits.push(
      <span key="author" className="text-gray-500">
        {d.postTitle}
      </span>,
    );
  } else if (item.kind === 'community_hot') {
    bits.push(
      <span key="mentions">
        <strong>{d.mentionCount}</strong> mentions · conviction {d.convictionScore?.toFixed(0)}
      </span>,
    );
    if (d.topTags && d.topTags.length > 0) {
      bits.push(
        <span key="tags" className="text-gray-600">
          {d.topTags.map(strategyLabel).join(', ')}
        </span>,
      );
    }
  }

  return <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">{bits}</div>;
}

export function SignalsPage({ snapshot, isLoading, error, onRefresh }: SignalsPageProps) {
  const [hidden, setHidden] = useState<Set<SignalKind>>(new Set());

  const toggleKind = (kind: SignalKind) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const items = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.items.filter((i) => !hidden.has(i.kind));
  }, [snapshot, hidden]);

  if (isLoading && !snapshot) {
    return <div className="p-6 text-gray-500">Loading signals...</div>;
  }
  if (error && !snapshot) {
    return (
      <div className="p-6">
        <div className="text-red-600 mb-2">Failed to load: {error}</div>
        <button onClick={onRefresh} className="bg-blue-600 text-white px-3 py-1.5 rounded text-sm">
          Retry
        </button>
      </div>
    );
  }
  if (!snapshot) return <div className="p-6 text-gray-500">No data</div>;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow p-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide mr-1">Show</span>
        {KIND_ORDER.map((k) => {
          const meta = KIND_META[k];
          const count = snapshot.counts[k];
          const isHidden = hidden.has(k);
          return (
            <button
              key={k}
              onClick={() => toggleKind(k)}
              className={`text-xs px-2 py-0.5 rounded border transition ${
                isHidden
                  ? 'bg-white text-gray-400 border-gray-200 line-through'
                  : `${meta.classes} border-transparent`
              }`}
            >
              {meta.label} {count}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-gray-500">As of {fmtTime(snapshot.asOf)}</span>
          <button
            onClick={onRefresh}
            className="text-xs px-2 py-0.5 rounded bg-gray-800 text-white hover:bg-black"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow">
        {items.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500">
            No signals match current filters.
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {items.map((item) => {
              const meta = KIND_META[item.kind];
              return (
                <li key={item.id} className="px-4 py-3 flex items-start gap-3 hover:bg-gray-50">
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${meta.classes}`}>
                    {meta.label}
                  </span>
                  <Link
                    to={`/symbol/${item.symbol}`}
                    className="font-semibold text-blue-700 hover:underline shrink-0 w-16"
                  >
                    {item.symbol}
                  </Link>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-800">{item.headline}</div>
                    <div className="mt-0.5 text-gray-700">
                      <ItemDetails item={item} />
                    </div>
                  </div>
                  {item.occurredAt && (
                    <span className="text-xs text-gray-500 shrink-0 tabular-nums">
                      {fmtTime(item.occurredAt)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
