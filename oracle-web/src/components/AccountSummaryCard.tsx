import { JournalSnapshot } from '../types';

interface AccountSummaryCardProps {
  snapshot: JournalSnapshot | null;
  isLoading?: boolean;
  error?: string | null;
  onRefresh?: () => Promise<void>;
  showRefresh?: boolean;
}

function money(v: number, prefix: string = '$'): string {
  const sign = v < 0 ? '-' : '';
  return `${sign}${prefix}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pnlColor(v: number): string {
  if (v > 0.01) return 'text-green-700';
  if (v < -0.01) return 'text-red-700';
  return 'text-gray-600';
}

interface StatProps {
  label: string;
  value: string;
  color?: string;
  sub?: string;
}

function Stat({ label, value, color = 'text-gray-900', sub }: StatProps) {
  return (
    <div>
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 tabular-nums">{sub}</div>}
    </div>
  );
}

export function AccountSummaryCard({
  snapshot,
  isLoading,
  error,
  onRefresh,
  showRefresh = true,
}: AccountSummaryCardProps) {
  if (!snapshot) {
    return (
      <div className="bg-white rounded-lg shadow p-4 text-sm text-gray-500">
        {error ? `Account unavailable: ${error}` : isLoading ? 'Loading account…' : 'No account data'}
      </div>
    );
  }

  const { account, execution } = snapshot;
  const dailyPct =
    account.equity > 0 ? (account.dailyTotalPnl / (account.equity - account.dailyTotalPnl)) * 100 : 0;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-900">
          Account Summary
          {execution.paper && (
            <span className="ml-2 text-xs font-normal bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
              PAPER
            </span>
          )}
          {!execution.enabled && (
            <span className="ml-2 text-xs font-normal bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
              EXECUTION OFF
            </span>
          )}
        </h2>
        {showRefresh && onRefresh && (
          <button onClick={onRefresh} className="text-sm text-blue-600 hover:text-blue-800">
            Refresh
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <Stat label="Equity" value={money(account.equity)} />
        <Stat label="Cash" value={money(account.cash)} />
        <Stat label="Deployed" value={money(account.deployedCapital)} />
        <Stat
          label="Daily P&L"
          value={money(account.dailyTotalPnl)}
          color={pnlColor(account.dailyTotalPnl)}
          sub={`${dailyPct >= 0 ? '+' : ''}${dailyPct.toFixed(2)}%`}
        />
        <Stat
          label="Realized"
          value={money(account.dailyRealizedPnl)}
          color={pnlColor(account.dailyRealizedPnl)}
        />
        <Stat
          label="Unrealized"
          value={money(account.unrealizedPnl)}
          color={pnlColor(account.unrealizedPnl)}
        />
        <Stat
          label="Positions"
          value={`${execution.openPositions}/${execution.maxPositions}`}
          sub={execution.pendingOrders > 0 ? `+${execution.pendingOrders} pending` : undefined}
        />
      </div>
    </div>
  );
}
