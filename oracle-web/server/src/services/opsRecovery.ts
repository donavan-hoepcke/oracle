import type { ProbeName } from '../types/opsHealth.js';

/** A recovery action is "stop and start the underlying service".
 *  Returns true if the action ran without throwing — NOT whether
 *  the dependency is actually back online. The next probe cycle
 *  decides if recovery worked. */
export type RecoveryAction = () => Promise<void>;

export type RecoveryRegistry = Partial<Record<ProbeName, RecoveryAction>>;

/** Build the default registry from live service handles. The four
 *  scraper services share a stop/start interface; this just composes
 *  them into a single async fn per probe name. */
export interface ScraperServiceLike {
  stop(): Promise<void>;
  start(): Promise<void>;
}

export function buildDefaultRegistry(deps: {
  tickerBotService: ScraperServiceLike;
  moderatorAlertService: ScraperServiceLike;
  incomeTraderChatService: ScraperServiceLike;
  floatMapService: ScraperServiceLike;
  sectorHotnessService: ScraperServiceLike;
}): RecoveryRegistry {
  const restart = (svc: ScraperServiceLike): RecoveryAction => async () => {
    await svc.stop();
    await svc.start();
  };
  return {
    oracle_scraper: restart(deps.tickerBotService),
    moderator_alerts: restart(deps.moderatorAlertService),
    income_trader_chat: restart(deps.incomeTraderChatService),
    float_map: restart(deps.floatMapService),
    sector_hotness: restart(deps.sectorHotnessService),
  };
}
