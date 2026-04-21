import { Link, useParams } from 'react-router-dom';
import { useSymbolDetail } from '../hooks/useSymbolDetail';
import { SymbolDetail } from '../types';
import { ZoneBar } from './ZoneBar';

function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined) return '--';
  return `$${v.toFixed(3)}`;
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '--';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function fmtR(v: number | null | undefined): string {
  if (v === null || v === undefined) return '--';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}R`;
}

function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return '--';
  const sign = v >= 0 ? '+' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--' : d.toLocaleString();
}

function strategyLabel(s: string): string {
  return s.split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
}

function Section({ title, children, subtitle }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-lg shadow p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">{title}</h2>
        {subtitle && <span className="text-xs text-gray-500">{subtitle}</span>}
      </header>
      {children}
    </section>
  );
}

function KeyValue({ label, value, valueClass }: { label: string; value: React.ReactNode; valueClass?: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-gray-400">{label}</div>
      <div className={`font-semibold tabular-nums ${valueClass ?? 'text-gray-900'}`}>{value}</div>
    </div>
  );
}

function OverviewSection({ detail }: { detail: SymbolDetail }) {
  const s = detail.stockState;
  const current = s?.currentPrice ?? null;
  const change = s?.changePercent ?? null;
  const changeClass = change === null ? 'text-gray-500' : change >= 0 ? 'text-green-700' : 'text-red-700';
  return (
    <Section title="Overview" subtitle={`As of ${fmtTime(detail.asOf)}`}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KeyValue label="Current" value={fmtPrice(current)} />
        <KeyValue label="% Day" value={fmtPct(change)} valueClass={changeClass} />
        <KeyValue label="Trend 30m" value={s?.trend30m ?? '--'} />
        <KeyValue label="Signal" value={s?.signal ?? '--'} />
        <KeyValue label="Relative Vol" value={s?.relativeVolume ? s.relativeVolume.toFixed(2) + 'x' : '--'} />
        <KeyValue label="Float (M)" value={s?.floatMillions ? s.floatMillions.toFixed(1) : '--'} />
        <KeyValue
          label="Watchlist"
          value={detail.inWatchlist ? 'In Watchlist' : 'Not Loaded'}
          valueClass={detail.inWatchlist ? 'text-green-700' : 'text-gray-500'}
        />
        <KeyValue
          label="Wash Sale"
          value={detail.washSaleRisk ? '30d tight bar' : 'Clean'}
          valueClass={detail.washSaleRisk ? 'text-amber-700' : 'text-gray-500'}
        />
      </div>
    </Section>
  );
}

function OracleZoneSection({ detail }: { detail: SymbolDetail }) {
  const s = detail.stockState;
  if (!s) {
    return (
      <Section title="Oracle Zones">
        <div className="text-sm text-gray-500">Not in today's Oracle watchlist.</div>
      </Section>
    );
  }
  return (
    <Section title="Oracle Zones">
      <div className="mb-3">
        <ZoneBar
          stop={s.stopPrice ?? null}
          buy={s.buyZonePrice ?? null}
          sell={s.sellZonePrice ?? null}
          current={s.currentPrice}
          entry={detail.activeTrade?.entryPrice ?? null}
        />
      </div>
      <div className="grid grid-cols-3 gap-4 text-sm">
        <KeyValue label="Stop" value={fmtPrice(s.stopPrice)} valueClass="text-red-700" />
        <KeyValue label="Buy Zone" value={fmtPrice(s.buyZonePrice)} valueClass="text-blue-700" />
        <KeyValue label="Sell Zone" value={fmtPrice(s.sellZonePrice)} valueClass="text-green-700" />
      </div>
    </Section>
  );
}

function ActiveTradeSection({ detail }: { detail: SymbolDetail }) {
  const t = detail.activeTrade;
  if (!t) return null;
  const trailLabel = strategyLabel(t.trailingState);
  return (
    <Section title="Active Trade" subtitle={`Entered ${fmtTime(t.entryTime)}`}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <KeyValue label="Entry" value={fmtPrice(t.entryPrice)} />
        <KeyValue label="Stop" value={fmtPrice(t.currentStop)} valueClass="text-red-700" />
        <KeyValue label="Target" value={fmtPrice(t.target)} valueClass="text-green-700" />
        <KeyValue label="Shares" value={t.shares.toLocaleString()} />
        <KeyValue
          label="R Multiple"
          value={fmtR(t.rMultiple)}
          valueClass={(t.rMultiple ?? 0) >= 0 ? 'text-green-700' : 'text-red-700'}
        />
        <KeyValue
          label="Peak R (MFE)"
          value={fmtR(t.maxFavorableR)}
          valueClass="text-blue-700"
        />
        <KeyValue
          label="Unrealized"
          value={fmtMoney(t.unrealizedPl)}
          valueClass={(t.unrealizedPl ?? 0) >= 0 ? 'text-green-700' : 'text-red-700'}
        />
        <KeyValue label="State" value={trailLabel} valueClass="text-purple-700" />
      </div>
      {t.rationale.length > 0 && (
        <ul className="mt-3 text-xs text-gray-600 list-disc pl-5 space-y-0.5">
          {t.rationale.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function CandidateOrRejectionSection({ detail }: { detail: SymbolDetail }) {
  const { candidate, rejection } = detail;
  if (!candidate && !rejection) return null;
  return (
    <Section title={candidate ? 'Candidate (ranked)' : 'Rejected by Filters'}>
      {candidate && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <KeyValue label="Setup" value={strategyLabel(candidate.setup)} />
            <KeyValue label="Score" value={candidate.score.toFixed(0)} />
            <KeyValue label="Suggested Entry" value={fmtPrice(candidate.suggestedEntry)} />
            <KeyValue label="Suggested Stop" value={fmtPrice(candidate.suggestedStop)} valueClass="text-red-700" />
            <KeyValue label="Suggested Target" value={fmtPrice(candidate.suggestedTarget)} valueClass="text-green-700" />
            <KeyValue label="Oracle Score" value={candidate.oracleScore.toFixed(0)} />
            <KeyValue label="Message Score" value={candidate.messageScore.toFixed(0)} />
            <KeyValue label="Execution Score" value={candidate.executionScore.toFixed(0)} />
          </div>
          {candidate.rationale.length > 0 && (
            <ul className="text-xs text-gray-600 list-disc pl-5 space-y-0.5">
              {candidate.rationale.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {rejection && (
        <div className="space-y-2">
          <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
            <strong>{rejection.reason}</strong>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <KeyValue label="Setup" value={strategyLabel(rejection.setup)} />
            <KeyValue label="Score" value={rejection.score.toFixed(0)} />
            <KeyValue label="Suggested Entry" value={fmtPrice(rejection.suggestedEntry)} />
            <KeyValue label="Suggested Stop" value={fmtPrice(rejection.suggestedStop)} valueClass="text-red-700" />
            <KeyValue label="Suggested Target" value={fmtPrice(rejection.suggestedTarget)} valueClass="text-green-700" />
            <KeyValue label="At" value={fmtTime(rejection.timestamp)} />
          </div>
        </div>
      )}
    </Section>
  );
}

function CooldownSection({ detail }: { detail: SymbolDetail }) {
  if (!detail.cooldownExpiresAt) return null;
  const mins = Math.max(0, Math.round((new Date(detail.cooldownExpiresAt).getTime() - Date.now()) / 60000));
  return (
    <Section title="Cooldown">
      <div className="text-sm text-gray-700">
        Re-entry blocked for ~<strong>{mins}m</strong> (expires {fmtTime(detail.cooldownExpiresAt)}).
      </div>
    </Section>
  );
}

function FloatMapSection({ detail }: { detail: SymbolDetail }) {
  const f = detail.floatMap;
  if (!f) return null;
  return (
    <Section title="FloatMAP">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
        <KeyValue label="Rotation" value={f.rotation ? `${f.rotation.toFixed(1)}x` : '--'} />
        <KeyValue label="Last" value={fmtPrice(f.last)} />
        <KeyValue label="Float (M)" value={f.floatMillions ? f.floatMillions.toFixed(1) : '--'} />
        <KeyValue label="Next Support" value={fmtPrice(f.nextOracleSupport)} />
        <KeyValue label="Next Resistance" value={fmtPrice(f.nextOracleResistance)} />
      </div>
    </Section>
  );
}

function ModeratorSection({ detail }: { detail: SymbolDetail }) {
  const m = detail.moderator;
  const hasPrimary = m.primary !== null;
  if (!hasPrimary && m.backups.length === 0 && m.mentions.length === 0) return null;
  return (
    <Section title="Moderator (Tim Bohen)">
      {hasPrimary && m.primary && (
        <div className="mb-4 border-l-4 border-blue-500 pl-3">
          <div className="text-xs text-gray-500">
            {m.primaryPost?.title} — {fmtTime(m.primaryPost?.postedAt ?? null)}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-1 text-sm">
            <KeyValue label="Signal" value={fmtPrice(m.primary.signal)} valueClass="text-blue-700" />
            <KeyValue label="Risk Zone" value={fmtPrice(m.primary.riskZone)} valueClass="text-red-700" />
            <KeyValue label="Target" value={m.primary.target ?? '--'} valueClass="text-green-700" />
          </div>
        </div>
      )}
      {m.backups.length > 0 && (
        <div className="mb-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Listed as backup</div>
          <ul className="space-y-1 text-sm">
            {m.backups.map((b, i) => (
              <li key={i} className="flex gap-3">
                <span className="font-semibold">{fmtPrice(b.price)}</span>
                {b.note && <span className="text-gray-600">{b.note}</span>}
                <span className="text-xs text-gray-400 ml-auto">
                  {b.postTitle} · {fmtTime(b.postedAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {m.mentions.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">
            All mentions ({m.mentions.length})
          </div>
          <ul className="space-y-2 text-sm">
            {m.mentions.map((mention, i) => (
              <li key={i} className="border-l-2 border-gray-200 pl-2">
                <div className="flex justify-between text-xs text-gray-500">
                  <span>
                    {mention.title} · <span className="uppercase">{mention.role}</span>
                  </span>
                  <span>{fmtTime(mention.postedAt)}</span>
                </div>
                <div className="text-gray-700">{mention.excerpt}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function CommunitySection({ detail }: { detail: SymbolDetail }) {
  const ctx = detail.messageContext;
  const msgs = detail.recentMessages;
  if (ctx.mentionCount === 0 && msgs.length === 0) return null;
  return (
    <Section title="Community Signal" subtitle={`Conviction ${ctx.convictionScore.toFixed(0)}`}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mb-3">
        <KeyValue label="Mentions (30m)" value={ctx.mentionCount} />
        <KeyValue label="Last Mention" value={fmtTime(ctx.lastMentionAt)} />
        <KeyValue
          label="Top Tags"
          value={
            Object.entries(ctx.tagCounts)
              .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
              .slice(0, 3)
              .map(([t, c]) => `${strategyLabel(t)} (${c})`)
              .join(', ') || '--'
          }
        />
        <KeyValue label="Recent Msgs" value={msgs.length} />
      </div>
      {msgs.length > 0 && (
        <ul className="space-y-2 text-sm max-h-64 overflow-y-auto">
          {msgs.slice(0, 15).map((msg) => (
            <li key={msg.id} className="border-l-2 border-gray-200 pl-2">
              <div className="flex justify-between text-xs text-gray-500">
                <span>
                  {msg.author} in {msg.channel}
                  {msg.tags.length > 0 && <span className="ml-2">· {msg.tags.map(strategyLabel).join(', ')}</span>}
                </span>
                <span>{fmtTime(msg.timestamp)}</span>
              </div>
              <div className="text-gray-700">{msg.text}</div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function LedgerSection({ detail }: { detail: SymbolDetail }) {
  const trades = detail.closedTrades;
  if (trades.length === 0) return null;
  return (
    <Section title={`Closed Trades (${trades.length})`}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase text-gray-500">
            <tr>
              <th className="text-left px-2 py-1">Entry</th>
              <th className="text-left px-2 py-1">Exit</th>
              <th className="text-right px-2 py-1">Entry $</th>
              <th className="text-right px-2 py-1">Exit $</th>
              <th className="text-right px-2 py-1">Shares</th>
              <th className="text-right px-2 py-1">P&amp;L</th>
              <th className="text-right px-2 py-1">R</th>
              <th className="text-left px-2 py-1">Reason</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => (
              <tr key={i} className="border-t border-gray-100">
                <td className="px-2 py-1">{fmtTime(t.entryTime)}</td>
                <td className="px-2 py-1">{fmtTime(t.exitTime)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtPrice(t.entryPrice)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtPrice(t.exitPrice)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{t.shares}</td>
                <td
                  className={`px-2 py-1 text-right tabular-nums ${
                    t.pnl >= 0 ? 'text-green-700' : 'text-red-700'
                  }`}
                >
                  {fmtMoney(t.pnl)}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtR(t.rMultiple)}</td>
                <td className="px-2 py-1">{strategyLabel(t.exitReason)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

export function SymbolDetailPage() {
  const { ticker } = useParams<{ ticker: string }>();
  const symbol = ticker?.toUpperCase();
  const { detail, isLoading, error, refresh } = useSymbolDetail(symbol);

  if (!symbol) {
    return <div className="p-6 text-gray-500">Missing symbol.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <Link to="/" className="text-sm text-blue-700 hover:underline">
            ← Dashboard
          </Link>
          <h1 className="text-2xl font-bold text-gray-900">{symbol}</h1>
          {detail?.activeTrade && (
            <span className="text-xs px-2 py-0.5 rounded bg-green-600 text-white font-semibold">TRADED</span>
          )}
          {!detail?.activeTrade && detail?.rejection && (
            <span className="text-xs px-2 py-0.5 rounded bg-yellow-200 text-yellow-900 font-semibold">REJECTED</span>
          )}
          {!detail?.activeTrade && detail?.candidate && (
            <span className="text-xs px-2 py-0.5 rounded bg-blue-600 text-white font-semibold">CANDIDATE</span>
          )}
        </div>
        <button
          onClick={refresh}
          className="text-xs px-2 py-1 rounded bg-gray-200 text-gray-700 hover:bg-gray-300"
        >
          Refresh
        </button>
      </div>

      {isLoading && !detail && <div className="text-gray-500">Loading…</div>}
      {error && !detail && <div className="text-red-600">Failed to load: {error}</div>}
      {detail && (
        <>
          <OverviewSection detail={detail} />
          <ActiveTradeSection detail={detail} />
          <CandidateOrRejectionSection detail={detail} />
          <CooldownSection detail={detail} />
          <OracleZoneSection detail={detail} />
          <FloatMapSection detail={detail} />
          <ModeratorSection detail={detail} />
          <CommunitySection detail={detail} />
          <LedgerSection detail={detail} />
        </>
      )}
    </div>
  );
}
