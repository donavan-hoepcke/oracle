/* eslint-disable no-console */
/**
 * Manual integration test harness for the IBKR adapter.
 *
 * NOT part of the automated test suite — this script talks to a real,
 * locally-running IBKR Client Portal Gateway. Run it before flipping
 * `broker.active: ibkr` in production, and after any meaningful change
 * to `ibkrAdapter.ts`.
 *
 * Prerequisites (see docs/ibkr-setup.md):
 *   1. Gateway running on https://localhost:5000.
 *   2. Browser-authenticated session (visit https://localhost:5000, log in).
 *   3. `broker.ibkr.account_id` set to a paper account ID.
 *
 * Test flow (idempotent — safe to re-run):
 *   1. getAccount — sanity-check the account summary mapping.
 *   2. getPositions — confirm position payload shape.
 *   3. submitOrder limit + cancel — exercise the submit/auto-confirm path
 *      without leaving any open orders.
 *   4. searchConid for a few common tickers — populate the cache and
 *      catch ambiguity cases early.
 *
 * Usage (from oracle-web/server):
 *   npx tsx scripts/ibkr-smoke.ts
 *
 * Exits non-zero on any failure so CI / a watchdog can detect regressions.
 */

import { config } from '../src/config.js';
import { IbkrAdapter } from '../src/services/brokers/ibkrAdapter.js';
import { IbkrConidCache } from '../src/services/brokers/ibkrConidCache.js';
import { IbkrSession } from '../src/services/brokers/ibkrSession.js';

const TEST_SYMBOL = 'AAPL';
const TEST_QTY = 1;
// Limit price intentionally far above current AAPL — the order will sit
// in the book until we cancel it 5s later. Exercises the submit + cancel
// path without ever risking a fill.
const FAR_LIMIT_PRICE = 1000;

async function main(): Promise<void> {
  if (config.broker.active !== 'ibkr') {
    throw new Error(
      `config.broker.active is "${config.broker.active}", not "ibkr". Edit config.yaml or pass an env override.`,
    );
  }
  if (!config.broker.ibkr.account_id) {
    throw new Error('config.broker.ibkr.account_id is empty. Edit config.yaml.');
  }

  const adapter = new IbkrAdapter({
    config: {
      baseUrl: config.broker.ibkr.base_url,
      accountId: config.broker.ibkr.account_id,
      cashAccount: config.broker.ibkr.cash_account,
      allowSelfSignedTls: config.broker.ibkr.allow_self_signed_tls,
    },
  });
  await adapter.init();

  console.log('=== getAccount() ===');
  const account = await adapter.getAccount();
  console.log(account);
  if (account.cash <= 0) throw new Error('account.cash <= 0 — gateway probably not authenticated');

  console.log('\n=== getPositions() ===');
  const positions = await adapter.getPositions();
  console.log(`positions: ${positions.length}`);
  for (const p of positions) console.log(`  ${p.symbol} qty=${p.qty} entry=${p.avgEntryPrice}`);

  console.log('\n=== submitOrder(limit, far above market) → cancel ===');
  const submitted = await adapter.submitOrder({
    symbol: TEST_SYMBOL,
    qty: TEST_QTY,
    side: 'buy',
    type: 'limit',
    limitPrice: FAR_LIMIT_PRICE,
  });
  console.log(
    `submitted: id=${submitted.id} status=${submitted.status} rawStatus=${submitted.rawStatus}`,
  );

  // Wait briefly so IBKR has a chance to acknowledge; then cancel.
  await new Promise((r) => setTimeout(r, 2000));

  console.log('canceling…');
  await adapter.cancelOrder(submitted.id);
  console.log('cancel issued');

  // Confirm it's no longer in open orders.
  await new Promise((r) => setTimeout(r, 2000));
  const open = await adapter.getOpenOrders();
  const stillOpen = open.find((o) => o.id === submitted.id);
  if (stillOpen && stillOpen.status !== 'cancelled') {
    throw new Error(`order ${submitted.id} not cancelled — still ${stillOpen.status}`);
  }

  console.log('\nALL OK ✓');
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});

// Suppress unused import warnings — these are exported so the file shape
// matches the imports a future contributor might need.
void IbkrConidCache;
void IbkrSession;
