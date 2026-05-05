import { config } from '../../config.js';
import type { BrokerAdapter } from '../../types/broker.js';
import { AlpacaAdapter } from './alpacaAdapter.js';

function createBrokerAdapter(): BrokerAdapter {
  switch (config.broker.active) {
    case 'alpaca':
      return new AlpacaAdapter();
    case 'ibkr':
      throw new Error(
        'IBKR adapter not implemented yet (Phase 2). Set broker.active to "alpaca".',
      );
    default: {
      // Exhaustiveness guard — narrows config.broker.active to never.
      const exhaustive: never = config.broker.active;
      throw new Error(`Unknown broker: ${exhaustive as string}`);
    }
  }
}

/**
 * The active broker, selected at startup from config.broker.active. All
 * downstream services (executionService, tradeReconciliationService,
 * journal endpoints) talk to the broker through this singleton — never
 * through a vendor SDK directly.
 */
export const brokerService: BrokerAdapter = createBrokerAdapter();
