import { useWebSocket } from './hooks/useWebSocket';
import { useNotifications } from './hooks/useNotifications';
import { StatusBar } from './components/StatusBar';
import { StockTable } from './components/StockTable';
import { TickerSourceMode } from './types';

function App() {
  const { stocks, marketStatus, botStatus, isConnected, lastUpdate, alerts, clearAlert } =
    useWebSocket();

  const { hasPermission, requestPermission } = useNotifications(alerts, clearAlert);

  const updateSource = async (source: TickerSourceMode) => {
    await fetch('/api/bot/source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
    });
  };

  const startBot = async () => {
    await fetch('/api/bot/start', { method: 'POST' });
  };

  const stopBot = async () => {
    await fetch('/api/bot/stop', { method: 'POST' });
  };

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold text-gray-900">Oracle Stock Monitor</h1>
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
        <div className="bg-white rounded-lg shadow p-4 mb-4 flex flex-wrap items-center gap-3">
          <span className="text-sm text-gray-600 font-medium">Ticker Source</span>

          <select
            className="border border-gray-300 rounded px-2 py-1 text-sm"
            value={botStatus?.source ?? 'excel'}
            onChange={(e) => updateSource(e.target.value as TickerSourceMode)}
          >
            <option value="excel">Excel Watchlist</option>
            <option value="playwright">Playwright Web Page</option>
          </select>

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

        <div className="bg-white rounded-lg shadow">
          <StockTable stocks={stocks} />
        </div>

        <p className="text-center text-gray-400 text-sm mt-4">
          Double-click a row to open in Robinhood
        </p>
      </main>
    </div>
  );
}

export default App;
