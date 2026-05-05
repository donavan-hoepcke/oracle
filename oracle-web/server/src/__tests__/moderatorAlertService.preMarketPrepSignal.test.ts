import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    bot: {
      moderatorAlerts: {
        enabled: false,
        urls: [],
        poll_interval_sec: 120,
        hydration_wait_ms: 0,
      },
      playwright: { chrome_cdp_url: '' },
    },
  },
}));

import { parseModeratorAlertText } from '../services/moderatorAlertService.js';

/**
 * Regression for downstream stock_o_bot soak: Tim Bohen's actual day-of trade
 * signals frequently arrive as "Pre-Market Prep" posts whose body embeds a
 * full Signal: / Risk Zone: / Target: block, rather than as their own
 * "Daily Market Profits Alert" post. The earlier parser only ran signal
 * extraction when kind==='alert', so these were dropped to signal=null and
 * the bot treated the day's actual trade as editorial commentary.
 */
const SAMPLE = `Pre-Market Prep 5-4-2026

DMP Room
Masterclass

Daily Market Profits Alert 5-4-2026

$PN

By this time on day 2 99% of pennystocks are dead and buried, this still basing at pre support levels.
If it can bust the signal the day 2 squueze is on, no signal hit let it die.

Signal: $6.01
Risk Zone: $5.70
Target: Mid to high $6's

Backups:

$CNSP $10.65
$CLNN $7.54
$MNDR $1.34

Pre-Market Prep
DMP Room
Tim Bohen
May 4, 2026 6:43 AM`;

describe('parseModeratorAlertText — signal embedded in Pre-Market Prep', () => {
  it('extracts the signal block from a pre_market_prep post', () => {
    const posts = parseModeratorAlertText(SAMPLE);
    expect(posts).toHaveLength(1);
    const post = posts[0];

    expect(post.kind).toBe('pre_market_prep');
    expect(post.author).toBe('Tim Bohen');
    expect(post.signal).not.toBeNull();
    expect(post.signal?.symbol).toBe('PN');
    expect(post.signal?.signal).toBeCloseTo(6.01);
    expect(post.signal?.riskZone).toBeCloseTo(5.7);
    expect(post.signal?.target).toBe("Mid to high $6's");
    expect(post.signal?.targetFloor).toBeCloseTo(6);
  });

  it('extracts the backups list from the same prep post', () => {
    const posts = parseModeratorAlertText(SAMPLE);
    const backups = posts[0].backups;
    expect(backups).toHaveLength(3);
    expect(backups.map((b) => b.symbol)).toEqual(['CNSP', 'CLNN', 'MNDR']);
    expect(backups[0].price).toBeCloseTo(10.65);
    expect(backups[1].price).toBeCloseTo(7.54);
    expect(backups[2].price).toBeCloseTo(1.34);
  });
});

describe('parseModeratorAlertText — pre_market_prep without a signal', () => {
  it('still parses the post but leaves signal/backups empty', () => {
    const text = `Pre-Market Prep

Just a heads up that we're watching the open today, no specific picks yet.

Pre-Market Prep
DMP Room
Tim Bohen
May 4, 2026 6:43 AM`;
    const posts = parseModeratorAlertText(text);
    expect(posts).toHaveLength(1);
    expect(posts[0].kind).toBe('pre_market_prep');
    expect(posts[0].signal).toBeNull();
    expect(posts[0].backups).toEqual([]);
  });
});
