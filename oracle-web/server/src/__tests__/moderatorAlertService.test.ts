import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    bot: {
      moderatorAlerts: {
        enabled: false,
        url: '',
        poll_interval_sec: 120,
        hydration_wait_ms: 0,
      },
      playwright: { chrome_cdp_url: '' },
    },
  },
}));

import { parseModeratorAlertText } from '../services/moderatorAlertService.js';

// Excerpt of the Daily Market Profits room innerText — two alert posts and a
// backup-ideas post, each closed by the 4-line type/rooms/author/timestamp
// footer.
const SAMPLE = `Announcements

Backup Ideas 4-20-2026

$TOVX $0.45

$PBM $13.73

Double taps Later:

$ARTL $5.14

$ENVB $4.87

Daily Market Profit Alert
Daily Income Trader, Daily Market Profits +1 more
Tim Bohen
Apr 20, 2026 6:36 AM

Daily Market Profits Alert 4-20-2026

$ENVB early signals been hot!! Another one to fast for me to alert, but you all have oracle.

$CMND

Mushroom play

Signal: $1.36
Risk Zone: VWAPish $1.20
Target: $1.50+

Daily Market Profit Alert
Daily Income Trader, Daily Market Profits +1 more
Tim Bohen
Apr 20, 2026 6:34 AM

Daily Market Profits Alert 4-15-2026

$BIRD

Killer RCT in pre, and now dieng at the open like 9 out of 10 chat pumps. Love this for as quuesze on a double tap of the signal

Signal: $7.20
Risk Zone: $$6.99
Target: $9+

Daily Market Profit Alert
Daily Income Trader, Daily Market Profits +1 more
Tim Bohen
Apr 15, 2026 6:33 AM
`;

describe('parseModeratorAlertText', () => {
  it('splits posts on the timestamp footer', () => {
    const posts = parseModeratorAlertText(SAMPLE);
    expect(posts).toHaveLength(3);
    expect(posts.map((p) => p.kind)).toEqual(['backups', 'alert', 'alert']);
  });

  it('extracts the Signal/Risk Zone/Target triplet and primary ticker', () => {
    const posts = parseModeratorAlertText(SAMPLE);
    const cmnd = posts[1];
    expect(cmnd.signal).toEqual({
      symbol: 'CMND',
      signal: 1.36,
      riskZone: 1.2,
      target: '$1.50+',
      targetFloor: 1.5,
    });
  });

  it('tolerates "VWAPish $x.xx" risk-zone prose and double-dollar typos', () => {
    const posts = parseModeratorAlertText(SAMPLE);
    expect(posts[1].signal?.riskZone).toBe(1.2);
    expect(posts[2].signal?.riskZone).toBe(6.99);
  });

  it('picks the ticker closest to the Signal: line, skipping narrative mentions', () => {
    const posts = parseModeratorAlertText(SAMPLE);
    // $ENVB is mentioned in narrative before $CMND, but $CMND is the primary.
    expect(posts[1].signal?.symbol).toBe('CMND');
  });

  it('parses backup tickers with prices and notes', () => {
    const posts = parseModeratorAlertText(SAMPLE);
    const backups = posts[0].backups;
    expect(backups.map((b) => b.symbol)).toEqual(['TOVX', 'PBM', 'ARTL', 'ENVB']);
    expect(backups[0]).toEqual({ symbol: 'TOVX', price: 0.45, note: null });
  });

  it('parses timestamps into ISO strings and captures the author', () => {
    const posts = parseModeratorAlertText(SAMPLE);
    expect(posts[0].author).toBe('Tim Bohen');
    expect(posts[0].postedAt).toMatch(/^2026-04-20T\d{2}:36:00/);
  });

  it('returns an empty array for text with no timestamped posts', () => {
    expect(parseModeratorAlertText('')).toEqual([]);
    expect(parseModeratorAlertText('nothing here')).toEqual([]);
  });

  it('keeps target text raw and extracts a numeric floor when possible', () => {
    const raw = `Daily Market Profits Alert 4-14-2026

$SNAL

Signal: $0.85
Risk Zone: $0.75
Target: Mid to high $2's

Daily Market Profit Alert
Daily Income Trader, Daily Market Profits +1 more
Tim Bohen
Apr 14, 2026 6:37 AM
`;
    const [post] = parseModeratorAlertText(raw);
    expect(post.signal?.target).toBe("Mid to high $2's");
    expect(post.signal?.targetFloor).toBe(2);
  });

  it('parses backup lines with descriptive notes around the price', () => {
    const raw = `Backup Ideas 4-13-2026

$RMSG Double tap on $1.18

$IMA $5.60

Daily Market Profit Alert
Daily Income Trader, Daily Market Profits +1 more
Tim Bohen
Apr 13, 2026 6:40 AM
`;
    const [post] = parseModeratorAlertText(raw);
    expect(post.backups).toEqual([
      { symbol: 'RMSG', price: 1.18, note: 'Double tap on' },
      { symbol: 'IMA', price: 5.6, note: null },
    ]);
  });
});
