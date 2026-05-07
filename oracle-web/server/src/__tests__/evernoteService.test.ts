import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import {
  EvernoteService,
  findEvernoteUrls,
  findEvernoteUrlForTitle,
  looksLikePlaceholder,
} from '../services/evernoteService.js';

describe('findEvernoteUrls', () => {
  it('extracts both lite and canonical share URLs', () => {
    const text = `chat preamble
https://lite.evernote.com/note/aaaaaaaa-1111-2222-3333-444444444444 today's prep
nothing here
https://www.evernote.com/note/bbbbbbbb-5555-6666-7777-888888888888`;
    const urls = findEvernoteUrls(text);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('lite.evernote.com/note/aaaaaaaa');
    expect(urls[1]).toContain('www.evernote.com/note/bbbbbbbb');
  });

  it('returns empty list when no URLs present', () => {
    expect(findEvernoteUrls('hello world')).toEqual([]);
  });
});

describe('findEvernoteUrlForTitle', () => {
  it('returns the URL closest to the matching title line', () => {
    const text = `Pre Market Prep Note 5-1-2026
https://lite.evernote.com/note/aaaaaaaa-1111-2222-3333-444444444444
some chatter

Pre Market Prep Note 5-6-2026
https://lite.evernote.com/note/bbbbbbbb-5555-6666-7777-888888888888
more chatter`;
    const url = findEvernoteUrlForTitle('Pre Market Prep Note 5-6-2026', text);
    expect(url).toContain('bbbbbbbb');
  });

  it('falls back to the last URL when title not found', () => {
    const text = `https://lite.evernote.com/note/aaaaaaaa-1111-2222-3333-444444444444
https://lite.evernote.com/note/bbbbbbbb-5555-6666-7777-888888888888`;
    const url = findEvernoteUrlForTitle('not in text', text);
    expect(url).toContain('bbbbbbbb');
  });

  it('returns null when no Evernote URL exists', () => {
    expect(findEvernoteUrlForTitle('Pre Market Prep', 'no urls here')).toBeNull();
  });
});

describe('looksLikePlaceholder', () => {
  it('flags the actual stub captured in production on 2026-05-07', () => {
    // Verbatim from /api/moderator-alerts after the bug surfaced — 86
    // chars of chrome + title + "Sign in", no real note content.
    const stub = `Welcome to Evernote Lite editor!
Loading note...
Pre Market Prep Note 5-7-2026
Sign in`;
    expect(looksLikePlaceholder(stub)).toBe(true);
  });

  it('flags the bare "Loading note" string regardless of length', () => {
    const stub = 'something else'.repeat(100) + ' Loading note... ' + 'more'.repeat(50);
    expect(looksLikePlaceholder(stub)).toBe(true);
  });

  it('flags the Lite editor banner when total body is short', () => {
    const stub = 'Welcome to Evernote Lite editor!\nSome chrome\nSign in';
    expect(looksLikePlaceholder(stub)).toBe(true);
  });

  it('does NOT flag a fully-hydrated note that just happens to mention "loading"', () => {
    // A real Bohen prep is several hundred chars and contains structured
    // content. Mentioning "loading" in narrative shouldn't trip the gate
    // — only the literal "Loading note" hydration string does.
    const real = `Pre Market Prep Note 5-7-2026

Today's primary watch: $WATCHME — clean breakout above the prior session high.
Look for buyers stepping in around the prior pivot, with size confirming.

Backups:
$BACKUP1 — basing pattern, watching $1.85 reclaim
$BACKUP2 — sympathy play if sector breaks out (sector also showed loading dynamics yesterday)

Notes on regime: SPY held the 50-day yesterday on close. Risk-on tilt unless we lose $580 on SPY pre-market.`;
    expect(looksLikePlaceholder(real)).toBe(false);
  });

  it('does NOT flag a long body that contains the Lite banner (defensive — partial hydration)', () => {
    // If body length is past the threshold, even if banner is still
    // visible, treat it as legitimately hydrated. Reduces false positives
    // when Evernote's chrome bleeds into a real note capture.
    const partial = 'Welcome to Evernote Lite editor!\n' + 'real prep content '.repeat(50);
    expect(looksLikePlaceholder(partial)).toBe(false);
  });
});

describe('EvernoteService cache', () => {
  let svc: EvernoteService;
  const url = 'https://lite.evernote.com/note/cccccccc-9999-aaaa-bbbb-cccccccccccc';

  beforeEach(() => {
    svc = new EvernoteService();
  });

  it('returns primed value without invoking the network', async () => {
    svc.primeCache(url, {
      url,
      title: 'Pre Market Prep Note 5-6-2026',
      body: 'Top picks: $ABCD ...',
      fetchedAt: '2026-05-06T10:00:00.000Z',
    });
    const got = await svc.fetchNote(url);
    expect(got?.body).toBe('Top picks: $ABCD ...');
    expect(svc.cacheSize()).toBe(1);
  });

  it('does not cache when fetch returns null (disabled config)', async () => {
    // evernote.enabled is false in the mocked config so doFetch short-circuits
    // to null. The lookup MUST NOT cache that null — otherwise a transient
    // outage would lock in failure for the rest of the process lifetime.
    const got = await svc.fetchNote(url);
    expect(got).toBeNull();
    expect(svc.cacheSize()).toBe(0);
  });
});
