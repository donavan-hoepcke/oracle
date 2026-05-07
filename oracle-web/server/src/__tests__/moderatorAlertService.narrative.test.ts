import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    bot: {
      moderatorAlerts: {
        enabled: false,
        urls: [],
        poll_interval_sec: 120,
        hydration_wait_ms: 0,
        evernote: { enabled: false, hydration_wait_ms: 0 },
      },
      playwright: { chrome_cdp_url: '' },
    },
  },
}));

import { parseModeratorAlertText } from '../services/moderatorAlertService.js';

// Mirrors the 4-17-2026 alert structure where a narrative paragraph about
// $EFOI contains "30 minutes in advance" — previously mis-parsed as a backup
// with price 30.
const SAMPLE = `Daily Market Profits Alert 4-17-2026

$EFOI to fast to alert, but plenty of time to buy at the oracle signal as laid out 30 minutes in advance.

$MYSE

Morning fader on day 2 good area for risk, same thesis as $WNW yesterday

Signal: $3.96
Risk zone: $3.70
Target: Mid to high $4's

Backups:

$ISPC $0.19
$PBM $9.84
$UCAR $1.51
$BZAI double tap on $2.16

Daily Market Profit Alert
Daily Income Trader, Daily Market Profits +1 more
Tim Bohen
Apr 17, 2026 6:39 AM
`;

describe('parseModeratorAlertText narrative-vs-backup disambiguation', () => {
  it('rejects narrative $TICKER lines without an explicit $price from the backup list', () => {
    const [post] = parseModeratorAlertText(SAMPLE);
    const symbols = post.backups.map((b) => b.symbol);
    expect(symbols).not.toContain('EFOI');
    expect(symbols).toEqual(['ISPC', 'PBM', 'UCAR', 'BZAI']);
  });

  it('keeps $TICKER [note] $price backups intact', () => {
    const [post] = parseModeratorAlertText(SAMPLE);
    const bzai = post.backups.find((b) => b.symbol === 'BZAI');
    expect(bzai).toEqual({ symbol: 'BZAI', price: 2.16, note: 'double tap on' });
  });

  it('picks $MYSE as the primary signal, not the narrative $EFOI', () => {
    const [post] = parseModeratorAlertText(SAMPLE);
    expect(post.signal?.symbol).toBe('MYSE');
    expect(post.signal?.signal).toBe(3.96);
  });
});
