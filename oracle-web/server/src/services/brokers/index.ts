import { config } from '../../config.js';
import type { BrokerAdapter } from '../../types/broker.js';
import { AlpacaAdapter } from './alpacaAdapter.js';
import { IbkrAdapter } from './ibkrAdapter.js';

function createBrokerAdapter(): BrokerAdapter {
  switch (config.broker.active) {
    case 'alpaca':
      return new AlpacaAdapter();
    case 'ibkr':
      return new IbkrAdapter({
        config: {
          baseUrl: config.broker.ibkr.base_url,
          accountId: config.broker.ibkr.account_id,
          cashAccount: config.broker.ibkr.cash_account,
          allowSelfSignedTls: config.broker.ibkr.allow_self_signed_tls,
        },
      });
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
 *
 * The IBKR adapter requires `init()` to be called once at startup before
 * the first request, so the keepalive fires and the conid cache loads
 * from disk. The Alpaca adapter is stateless and doesn't need init().
 * The factory does NOT call init() automatically — server bootstrap is
 * responsible for that, mirroring how moderatorAlertService.start() is
 * called.
 */
export const brokerService: BrokerAdapter = createBrokerAdapter();
