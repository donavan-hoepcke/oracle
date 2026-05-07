import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    bot: {
      moderatorAlerts: {
        enabled: false,
        urls: [],
        poll_interval_sec: 120,
        hydration_wait_ms: 0,
        evernote: { enabled: true, hydration_wait_ms: 0 },
      },
      playwright: { chrome_cdp_url: '' },
    },
  },
}));

import {
  enrichWithEvernoteBody,
  parseModeratorAlertText,
  type ModeratorPost,
} from '../services/moderatorAlertService.js';
import { evernoteService } from '../services/evernoteService.js';

const SAMPLE_RAW = `Pre Market Prep Note 5-6-2026

https://lite.evernote.com/note/aaaaaaaa-1111-2222-3333-444444444444

Pre-Market Prep Note
PRE-MARKET PREP
Tim Bohen
May 6, 2026 7:30 AM
`;

const PREP_URL =
  'https://lite.evernote.com/note/aaaaaaaa-1111-2222-3333-444444444444';

const HYDRATED_BODY = `Pre Market Prep Note 5-6-2026

Today's primary watch is $WATCHME — clean breakout setup off the prior session high. Look for volume confirmation above $4.20 with risk to $3.95.

Backups:
$BACKUP1 - basing pattern, watching $1.85
$BACKUP2 - sympathy play if sector breaks out

Notes on regime: SPY held the 50-day yesterday on close. Risk-on tilt unless we lose $580 on SPY pre-market.
`;

describe('enrichWithEvernoteBody', () => {
  beforeEach(() => {
    evernoteService.clearCache();
    evernoteService.primeCache(PREP_URL, {
      url: PREP_URL,
      title: 'Pre Market Prep Note 5-6-2026',
      body: HYDRATED_BODY,
      fetchedAt: '2026-05-06T11:30:00.000Z',
    });
  });

  it('replaces a short prep body with the Evernote note text', async () => {
    const posts = parseModeratorAlertText(SAMPLE_RAW);
    expect(posts).toHaveLength(1);
    const prep = posts[0];
    expect(prep.kind).toBe('pre_market_prep');
    expect(prep.body.length).toBeLessThan(200);

    const [enriched] = await enrichWithEvernoteBody(posts, SAMPLE_RAW);
    expect(enriched.body).toBe(HYDRATED_BODY);
    // Tickers from inside the note body must surface in `symbols` for
    // downstream consumers that correlate by ticker.
    expect(enriched.symbols).toContain('WATCHME');
    expect(enriched.symbols).toContain('BACKUP1');
    expect(enriched.symbols).toContain('BACKUP2');
  });

  it('passes through non-prep posts unchanged', async () => {
    const post: ModeratorPost = {
      title: 'Daily Market Profits Alert 5-6-2026',
      kind: 'alert',
      author: 'Tim Bohen',
      postedAt: '2026-05-06T13:30:00.000Z',
      body: 'short body',
      signal: null,
      backups: [],
      symbols: [],
    };
    const [out] = await enrichWithEvernoteBody([post], SAMPLE_RAW);
    expect(out).toBe(post);
  });

  it('skips prep posts that already have substantial body content', async () => {
    const longBody = 'x'.repeat(500);
    const post: ModeratorPost = {
      title: 'Pre Market Prep Note 5-6-2026',
      kind: 'pre_market_prep',
      author: 'Tim Bohen',
      postedAt: '2026-05-06T11:30:00.000Z',
      body: longBody,
      signal: null,
      backups: [],
      symbols: [],
    };
    const [out] = await enrichWithEvernoteBody([post], SAMPLE_RAW);
    expect(out.body).toBe(longBody);
  });

  it('preserves original body when no Evernote URL is in raw text', async () => {
    const rawNoUrl = SAMPLE_RAW.replace(PREP_URL, '');
    const posts = parseModeratorAlertText(rawNoUrl);
    const out = await enrichWithEvernoteBody(posts, rawNoUrl);
    // Enrichment is a no-op when no URL exists. The post survives parse
    // now (parser no longer drops empty-body prep) and is left for
    // `dropEmptyBodyPrepPosts` to remove afterward.
    if (out.length > 0) {
      expect(out[0].body).toBe('');
    }
  });

  it('hydrates a title-only chat stub from an Evernote URL elsewhere in rawText', async () => {
    // Real-world failure mode (2026-05-04 / 2026-05-05 logs): the chat
    // innerText capture has only the title + footer — the URL is rendered
    // as a clickable element that doesn't make it into innerText. But
    // OTHER parts of the page (e.g. the room sidebar or a sibling post's
    // body) carry the URL. Enrichment uses findEvernoteUrlForTitle which
    // scans the full rawText, so this still hydrates.
    const titleOnlyRaw = `Pre Market Prep Note 5-7-2026

Pre-Market Prep Note
PRE-MARKET PREP
Tim Bohen
May 7, 2026 4:30 AM

(unrelated chat below)
${PREP_URL}
random chatter
`;
    const posts = parseModeratorAlertText(titleOnlyRaw);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toBe('');
    const [enriched] = await enrichWithEvernoteBody(posts, titleOnlyRaw);
    expect(enriched.body).toBe(HYDRATED_BODY);
    expect(enriched.symbols).toContain('WATCHME');
  });
});
