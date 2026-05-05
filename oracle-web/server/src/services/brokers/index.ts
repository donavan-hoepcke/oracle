import { config } from '../../config.js';
import type { BrokerAdapter } from '../../types/broker.js';
import { AlpacaAdapter } from './alpacaAdapter.js';
import { IbkrAdapter } from './ibkrAdapter.js';

function createBrokerAdapter(): BrokerAdapter {
  switch (config.broker.active) {
    case 'alpaca':
      return new AlpacaAdapter();
    case 'ibkr': {
      const ibkr = config.broker.ibkr;
      const profileName = ibkr.profile;
      const profile = ibkr.profiles[profileName];
      // Conid caches must not collide between paper and live — symbol→conid
      // mappings differ across IBKR's paper and live universes for newly
      // listed tickers, and a stale paper conid pointed at a live order is
      // a real-money bug. Replace the {profile} placeholder so each profile
      // gets its own file.
      const conidCachePath = ibkr.conid_cache_path.replace('{profile}', profileName);
      return new IbkrAdapter({
        config: {
          baseUrl: profile.base_url,
          accountId: profile.account_id,
          cashAccount: profile.cash_account,
          allowSelfSignedTls: ibkr.allow_self_signed_tls,
          pollSessionKeepaliveSec: ibkr.poll_session_keepalive_sec,
          conidCachePath,
        },
      });
    }
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
