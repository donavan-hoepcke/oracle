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

  const startBot = async () => {
    try {
      const res = await fetch('/api/bot/start', { method: 'POST' });
      if (!res.ok) console.error('Failed to start bot:', res.status);
    } catch (err) {
      console.error('Failed to start bot:', err);
    }
  };

  const stopBot = async () => {
    try {
      const res = await fetch('/api/bot/stop', { method: 'POST' });
      if (!res.ok) console.error('Failed to stop bot:', res.status);
    } catch (err) {
      console.error('Failed to stop bot:', err);
    }
  };

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

        <div className="bg-white rounded-lg shadow p-4 mb-4 flex flex-wrap items-center gap-3">
          <button
            onClick={startBot}
            className="bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded text-sm"
          >
            Start Bot
          </button>

          <button
            onClick={stopBot}
            className="bg-gray-700 hover:bg-gray-800 text-white px-3 py-1.5 rounded text-sm"
          >
            Stop Bot
          </button>

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
