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

import { parseChatBodyAsAlert } from '../services/moderatorAlertService.js';

// The actual STT-Shirley BLZE chat body from 2026-05-05T18:48:36Z.
// Note "Risk Zone;" with a semicolon — that's the live data.
const BLZE_DOUBLE_DOWN =
  'Double Down Alert 5-5-2026 $BLZE(7.76/+13.12%) Killer looking vwap hold pattern, ' +
  'and nice mid day consolation Signal: $7.79 Risk Zone; $7.55 Target: $8.50+';

// CLNN body from 2026-05-04T18:41:53Z. Has a trailing "Note: $PN(...)" appendix.
const CLNN_DOUBLE_DOWN =
  'Double Down Alert 5-4-2026 $CLNN(7.26/-13.47%) ' +
  'Volume light, but sure looks like someone is sneaking this higher to try ' +
  'and push it into the close. Signal: $7.54 Risk Zone: Lower lever $7.37 ' +
  'Target: $8+ Note: $PN(5.27/+83.94%) not dead from the DMP alert';

describe('parseChatBodyAsAlert', () => {
  it("lifts STT-Shirley's BLZE Double Down into a kind='double_down' post", () => {
    const post = parseChatBodyAsAlert(
      BLZE_DOUBLE_DOWN,
      'STT- Shirley',
      '2026-05-05T18:48:36.376Z',
    );
    expect(post).not.toBeNull();
    expect(post!.kind).toBe('double_down');
    expect(post!.author).toBe('STT- Shirley');
    expect(post!.postedAt).toBe('2026-05-05T18:48:36.376Z');
    expect(post!.signal).toEqual({
      symbol: 'BLZE',
      signal: 7.79,
      riskZone: 7.55,
      target: '$8.50+',
      targetFloor: 8.5,
    });
    expect(post!.symbols).toContain('BLZE');
  });

  it('handles the CLNN body with Risk Zone narrative prefix and trailing Note', () => {
    const post = parseChatBodyAsAlert(
      CLNN_DOUBLE_DOWN,
      'STT- Shirley',
      '2026-05-04T18:41:53.703Z',
    );
    expect(post).not.toBeNull();
    expect(post!.kind).toBe('double_down');
    expect(post!.signal?.symbol).toBe('CLNN');
    expect(post!.signal?.signal).toBe(7.54);
    expect(post!.signal?.riskZone).toBe(7.37);
    // The "Note: $PN..." appendix should NOT pollute the primary signal.
    expect(post!.signal?.symbol).not.toBe('PN');
  });

  it('returns null for casual chat that mentions "Signal: $X" without a known title prefix', () => {
    const post = parseChatBodyAsAlert(
      'curious — $BLZE Signal: $7.79 looks tight here',
      'random_user',
      '2026-05-05T19:00:00Z',
    );
    expect(post).toBeNull();
  });

  it('returns null for an empty body', () => {
    expect(parseChatBodyAsAlert('', 'STT- Shirley', '2026-05-05T19:00:00Z')).toBeNull();
  });

  it("returns null when title classifies as 'alert' but body has no Signal: line", () => {
    // A bare "Daily Market Profits Alert 5-5-2026 saw some interesting setups"
    // shouldn't lift — we'd be inventing a structured alert from a casual mention.
    const post = parseChatBodyAsAlert(
      'Daily Market Profits Alert 5-5-2026 saw some interesting setups',
      'Tim Bohen',
      '2026-05-05T19:00:00Z',
    );
    expect(post).toBeNull();
  });

  it('lifts a Tim Bohen "Daily Market Profits Alert" chat-format post', () => {
    // Hypothetical: if Bohen ever pastes the alert body into chat, we should
    // pick it up identically to the alert-page version.
    const post = parseChatBodyAsAlert(
      'Daily Market Profits Alert 5-5-2026 $XYZ classic setup. Signal: $1.23 ' +
        'Risk Zone: $1.10 Target: $1.50+',
      'Tim Bohen',
      '2026-05-05T13:40:00Z',
    );
    expect(post).not.toBeNull();
    expect(post!.kind).toBe('alert');
    expect(post!.signal?.symbol).toBe('XYZ');
    expect(post!.signal?.signal).toBe(1.23);
    expect(post!.signal?.riskZone).toBe(1.1);
  });

  it('preserves a Double Down Note (no fresh Signal: block) — signal stays null', () => {
    // The "Double Down Note" form re-confirms an existing signal without a
    // fresh Signal: block. Symbols[] should still surface the ticker so
    // consumers can correlate to the original alert.
    const post = parseChatBodyAsAlert(
      'Double Down Note 5-5-2026 still riding $XYZ here',
      'STT- Shirley',
      '2026-05-05T19:30:00Z',
    );
    expect(post).not.toBeNull();
    expect(post!.kind).toBe('double_down');
    expect(post!.signal).toBeNull();
    expect(post!.symbols).toContain('XYZ');
  });
});
