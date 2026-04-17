import { useWebSocket } from './hooks/useWebSocket';
import { useNotifications } from './hooks/useNotifications';
import { useTradeCandidates } from './hooks/useTradeCandidates';
import { useJournal } from './hooks/useJournal';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { StatusBar } from './components/StatusBar';
import { StockTable } from './components/StockTable';
import { TradeIdeasPage } from './components/TradeIdeasPage';
import { JournalPage } from './components/JournalPage';
import { PremarketSyncBanner } from './components/PremarketSyncBanner';

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return isActive
    ? 'px-3 py-1.5 rounded bg-gray-900 text-white'
    : 'px-3 py-1.5 rounded bg-gray-200 text-gray-700 hover:bg-gray-300';
}

function App() {
  const { stocks, marketStatus, botStatus, isConnected, lastUpdate, alerts, clearAlert } =
    useWebSocket();
  const { candidates, asOf, isLoading, error, refresh } = useTradeCandidates(20);
  const {
    snapshot: journalSnapshot,
    isLoading: journalLoading,
    error: journalError,
    refresh: journalRefresh,
  } = useJournal();

  const { hasPermission, requestPermission } = useNotifications(alerts, clearAlert);

  const startScraper = async () => {
    try {
      const res = await fetch('/api/bot/start', { method: 'POST' });
      if (!res.ok) console.error('Failed to start scraper:', res.status);
    } catch (err) {
      console.error('Failed to start scraper:', err);
    }
  };

  const stopScraper = async () => {
    try {
      const res = await fetch('/api/bot/stop', { method: 'POST' });
      if (!res.ok) console.error('Failed to stop scraper:', res.status);
    } catch (err) {
      console.error('Failed to stop scraper:', err);
    }
  };

  const toggleExecution = async (enabled: boolean) => {
    try {
      const res = await fetch('/api/execution/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) console.error('Failed to toggle execution:', res.status);
      journalRefresh();
    } catch (err) {
      console.error('Failed to toggle execution:', err);
    }
  };

  const flattenAll = async () => {
    if (!confirm('Close ALL open positions immediately at market? This cannot be undone.')) return;
    try {
      const res = await fetch('/api/execution/flatten', { method: 'POST' });
      if (!res.ok) console.error('Failed to flatten:', res.status);
      journalRefresh();
    } catch (err) {
      console.error('Failed to flatten:', err);
    }
  };

  const executionEnabled = journalSnapshot?.execution.enabled ?? false;

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold text-gray-900">Oracle Stock Monitor</h1>
          <nav className="mt-3 flex items-center gap-3 text-sm">
            <NavLink
              to="/"
              className={navLinkClass}
              end
            >
              Dashboard
            </NavLink>
            <NavLink
              to="/ideas"
              className={navLinkClass}
            >
              Ideas
            </NavLink>
            <NavLink
              to="/journal"
              className={navLinkClass}
            >
              Journal
            </NavLink>
          </nav>
        </div>
      </header>

      <StatusBar
        marketStatus={marketStatus}
        botStatus={botStatus}
        isConnected={isConnected}
        lastUpdate={lastUpdate}
        stockCount={stocks.length}
        hasNotificationPermission={hasPermission}
        onRequestPermission={requestPermission}
      />

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-6">
        <PremarketSyncBanner marketStatus={marketStatus} botStatus={botStatus} stocks={stocks} />

        <div className="bg-white rounded-lg shadow p-4 mb-4 flex flex-wrap items-center gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide mr-1">
              Scraper
            </span>
            <button
              onClick={startScraper}
              title="Start the Playwright scraper that pulls today's Oracle picks into the watchlist"
              className="bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded text-sm"
            >
              Start
            </button>
            <button
              onClick={stopScraper}
              title="Stop the Oracle scraper. Existing watchlist stays loaded; no refresh."
              className="bg-gray-700 hover:bg-gray-800 text-white px-3 py-1.5 rounded text-sm"
            >
              Stop
            </button>
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                botStatus?.isRunning ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'
              }`}
            >
              {botStatus?.isRunning ? 'Running' : 'Stopped'}
            </span>
          </div>

          <div className="h-6 w-px bg-gray-200" />

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide mr-1">
              Execution
            </span>
            {executionEnabled ? (
              <button
                onClick={() => toggleExecution(false)}
                title="Pause auto-trading. Existing positions keep their stops; no new trades are entered."
                className="bg-orange-600 hover:bg-orange-700 text-white px-3 py-1.5 rounded text-sm"
              >
                Pause Trading
              </button>
            ) : (
              <button
                onClick={() => toggleExecution(true)}
                title="Resume auto-trading against the Alpaca paper account."
                className="bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded text-sm"
              >
                Start Trading
              </button>
            )}
            <button
              onClick={flattenAll}
              title="Emergency close: cancel all pending orders and market-sell every open position at Alpaca."
              className="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded text-sm"
            >
              Flatten All
            </button>
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                executionEnabled ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'
              }`}
            >
              {executionEnabled ? 'Active' : 'Paused'}
            </span>
            {journalSnapshot?.execution.paper && (
              <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-800">PAPER</span>
            )}
          </div>

          {botStatus?.lastError && (
            <span className="text-xs text-red-600">{botStatus.lastError}</span>
          )}
        </div>

        <Routes>
          <Route
            path="/"
            element={
              <>
                <div className="bg-white rounded-lg shadow">
                  <StockTable stocks={stocks} />
                </div>

                <p className="text-center text-gray-400 text-sm mt-4">
                  Double-click a row to open in Robinhood
                </p>
              </>
            }
          />
          <Route
            path="/ideas"
            element={
              <TradeIdeasPage
                candidates={candidates}
                asOf={asOf}
                isLoading={isLoading}
                error={error}
                onRefresh={refresh}
              />
            }
          />
          <Route
            path="/journal"
            element={
              <JournalPage
                snapshot={journalSnapshot}
                isLoading={journalLoading}
                error={journalError}
                onRefresh={journalRefresh}
              />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
