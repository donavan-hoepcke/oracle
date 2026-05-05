import { BotStatus, MarketStatus, OpsHealthSnapshot } from '../types';
import { OpsHealthDots } from './OpsHealthDots';

interface StatusBarProps {
  marketStatus: MarketStatus | null;
  botStatus: BotStatus | null;
  isConnected: boolean;
  lastUpdate: Date | null;
  stockCount: number;
  opsHealth: OpsHealthSnapshot | null;
}

export function StatusBar({
  marketStatus,
  botStatus,
  isConnected,
  lastUpdate,
  stockCount,
  opsHealth,
}: StatusBarProps) {
  return (
    <div className="bg-gray-800 text-white px-4 py-2 flex items-center justify-between text-sm">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              isConnected ? 'bg-green-500' : 'bg-red-500'
            }`}
            aria-hidden="true"
          />
          <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
        </div>

        <div className="text-gray-400">|</div>

        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              marketStatus?.isOpen ? 'bg-green-500' : 'bg-yellow-500'
            }`}
            aria-hidden="true"
          />
          <span>
            {marketStatus?.isOpen ? 'Market Open' : 'Market Closed'}
          </span>
          {marketStatus && (
            <span className="text-gray-400 text-xs">
              ({marketStatus.nextChange})
            </span>
          )}
        </div>

        <div className="text-gray-400">|</div>

        <span className="text-gray-300">
          {stockCount} symbol{stockCount !== 1 ? 's' : ''}
        </span>

        {botStatus && (
          <>
            <div className="text-gray-400">|</div>
            <span className="text-gray-300">
              Bot: {botStatus.isRunning ? 'Running' : 'Stopped'}
            </span>
          </>
        )}

        <div className="text-gray-400">|</div>
        <OpsHealthDots snapshot={opsHealth} />
      </div>

      <div className="flex items-center gap-4">
        {lastUpdate && (
          <span className="text-gray-400 text-xs">
            Last update: {lastUpdate.toLocaleTimeString()}
          </span>
        )}
      </div>
    </div>
  );
}
