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

import {
  parseModeratorAlertText,
  moderatorAlertService,
  mergeAndDedupe,
  dropEmptyBodyPrepPosts,
  type ModeratorPost,
} from '../services/moderatorAlertService.js';

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

  it('classifies "Double Down Alert ... $TICKER" as double_down with ticker in symbols[]', () => {
    // Format observed in the room when a moderator re-confirms an existing
    // signal mid-move. The bot's mod_double_down_long rule needs both the
    // kind label and the ticker to join back to the original alert.
    // Crucially: the ticker goes in `symbols[]`, NOT in `signal.symbol`,
    // because Double Down posts are not standalone primary signals — they
    // reference an existing one. Downstream `if (post.signal)` consumers
    // (signalsService, symbolDetailService) must keep treating only real
    // Signal:/Risk Zone:/Target: blocks as primary actionable.
    const raw = `Double Down Alert 5-4-2026 $CLNN

Signal still live, organic fills coming in.

Daily Market Profit Alert
Daily Income Trader, Daily Market Profits +1 more
STT-Shirley
May 4, 2026 10:13 AM
`;
    const [post] = parseModeratorAlertText(raw);
    expect(post.kind).toBe('double_down');
    expect(post.signal).toBeNull();
    expect(post.symbols).toContain('CLNN');
  });

  it('classifies "Double Down Note" with body ticker and extracts it into symbols[]', () => {
    const raw = `Double Down Note 4-23-2026

$XYZ adding here

Daily Market Profit Alert
Daily Income Trader, Daily Market Profits +1 more
Tim Bohen
Apr 23, 2026 10:00 AM
`;
    const [post] = parseModeratorAlertText(raw);
    expect(post.kind).toBe('double_down');
    expect(post.signal).toBeNull();
    expect(post.symbols).toContain('XYZ');
  });

  it('Double Down with a fresh Signal: block populates signal as a new level to watch', () => {
    // Per moderator convention: a Double Down usually re-confirms the *original*
    // signal (no new Signal: block, signal stays null). But sometimes a mod
    // identifies a *new level to watch* and attaches a fresh Signal:/Risk Zone:
    // block — in that case it IS a standalone actionable signal. The kind label
    // 'double_down' lets consumers distinguish it from a regular 'alert' while
    // still getting the structured data.
    const raw = `Double Down Alert 5-4-2026 $CLNN

New level to watch:

Signal: $7.95
Risk Zone: $7.70
Target: $9+

Daily Market Profit Alert
Daily Income Trader, Daily Market Profits +1 more
STT-Shirley
May 4, 2026 11:00 AM
`;
    const [post] = parseModeratorAlertText(raw);
    expect(post.kind).toBe('double_down');
    expect(post.signal?.symbol).toBe('CLNN');
    expect(post.signal?.signal).toBe(7.95);
    expect(post.signal?.riskZone).toBe(7.7);
    expect(post.symbols).toContain('CLNN');
  });

  it('classifies "Double Down Note" without ticker as double_down with empty symbols[]', () => {
    const raw = `Double Down Note 4-23-2026

Daily Market Profit Alert
Daily Income Trader, Daily Market Profits +1 more
Tim Bohen
Apr 23, 2026 10:00 AM
`;
    const [post] = parseModeratorAlertText(raw);
    expect(post.kind).toBe('double_down');
    expect(post.signal).toBeNull();
    expect(post.symbols).toEqual([]);
  });

  it('regression: Double Down with ticker does NOT pollute primary signal slot', () => {
    // symbolDetailService.collectModerator scans for post.signal && post.signal.symbol === target.
    // If we populated signal on Double Down posts, a fresh DD note could overwrite the real
    // alert as the symbol's primary with all numeric fields null. Guard against that.
    const raw = `Daily Market Profits Alert 5-4-2026

$CLNN

Signal: $7.54
Risk Zone: $7.16
Target: $9+

Daily Market Profit Alert
Daily Income Trader, Daily Market Profits +1 more
Tim Bohen
May 4, 2026 6:00 AM

Double Down Alert 5-4-2026 $CLNN

Re-confirming the signal.

Daily Market Profit Alert
Daily Income Trader, Daily Market Profits +1 more
STT-Shirley
May 4, 2026 10:13 AM
`;
    const posts = parseModeratorAlertText(raw);
    expect(posts).toHaveLength(2);
    const realAlert = posts.find((p) => p.kind === 'alert');
    const dd = posts.find((p) => p.kind === 'double_down');
    expect(realAlert?.signal?.signal).toBe(7.54);
    expect(realAlert?.signal?.riskZone).toBe(7.16);
    expect(dd?.signal).toBeNull();
    expect(dd?.symbols).toContain('CLNN');
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

describe('moderatorAlertService onAlerts subscription', () => {
  const samplePost: ModeratorPost = {
    title: 'Daily Market Profits Alert 5-2-2026',
    kind: 'alert',
    author: 'Tim Bohen',
    postedAt: '2026-05-02T13:42:00.000Z',
    body: '$ABCD\n\nSignal: $4.20\nRisk Zone: $3.95\nTarget: $4.80+',
    signal: {
      symbol: 'ABCD',
      signal: 4.2,
      riskZone: 3.95,
      target: '$4.80+',
      targetFloor: 4.8,
    },
    backups: [],
      symbols: [],
  };

  it('fires the listener when ingestPosts is called and stops after unsubscribe', () => {
    const captured: ModeratorPost[][] = [];
    const unsub = moderatorAlertService.onAlerts((posts) => captured.push(posts));
    moderatorAlertService.ingestPosts([samplePost]);
    moderatorAlertService.ingestPosts([samplePost, samplePost]);
    unsub();
    moderatorAlertService.ingestPosts([samplePost]);
    expect(captured.length).toBe(2);
    expect(captured[0]).toHaveLength(1);
    expect(captured[1]).toHaveLength(2);
    expect(captured[0][0].signal?.symbol).toBe('ABCD');
  });

  it('updates the snapshot when ingestPosts is called', () => {
    moderatorAlertService.ingestPosts([samplePost]);
    const snapshot = moderatorAlertService.getSnapshot();
    expect(snapshot.posts).toHaveLength(1);
    expect(snapshot.posts[0].signal?.symbol).toBe('ABCD');
    expect(snapshot.fetchedAt).not.toBeNull();
  });
});

describe('mergeAndDedupe', () => {
  const make = (title: string, postedAt: string | null): ModeratorPost => ({
    title,
    kind: 'alert',
    author: 'Tim Bohen',
    postedAt,
    body: '',
    signal: null,
    backups: [],
    symbols: [],
  });

  it('drops duplicates that share (postedAt, title)', () => {
    const a = make('Daily Market Profits Alert 5-4-2026', '2026-05-04T13:42:00.000Z');
    const b = make('Daily Market Profits Alert 5-4-2026', '2026-05-04T13:42:00.000Z');
    expect(mergeAndDedupe([a, b])).toHaveLength(1);
  });

  it('keeps posts that share a title but were posted at different times', () => {
    const a = make('Pre Market Prep Note', '2026-05-04T13:42:00.000Z');
    const b = make('Pre Market Prep Note', '2026-05-05T13:42:00.000Z');
    expect(mergeAndDedupe([a, b])).toHaveLength(2);
  });

  it('treats null postedAt consistently when titles match', () => {
    const a = make('Announcements', null);
    const b = make('Announcements', null);
    expect(mergeAndDedupe([a, b])).toHaveLength(1);
  });

  it('preserves order of first occurrence', () => {
    const first = make('alpha', '2026-05-04T01:00:00.000Z');
    const second = make('beta', '2026-05-04T02:00:00.000Z');
    const dup = make('alpha', '2026-05-04T01:00:00.000Z');
    const merged = mergeAndDedupe([first, second, dup]);
    expect(merged.map((p) => p.title)).toEqual(['alpha', 'beta']);
  });

  it('collapses same-day prep duplicates and prefers the longer body', () => {
    const sparse: ModeratorPost = {
      title: 'Pre Market Prep Note 5-5-2026',
      kind: 'pre_market_prep',
      author: 'Tim Bohen',
      postedAt: '2026-05-05T04:37:00.000Z',
      body: '',
      signal: null,
      backups: [],
      symbols: [],
    };
    const fat: ModeratorPost = {
      title: 'Pre-Market Prep',
      kind: 'pre_market_prep',
      author: 'Tim Bohen',
      postedAt: '2026-05-05T04:38:00.000Z',
      body: '$PN Signal: $6.01 Risk Zone: $5.70 Target: high $6s\nBackups: $CNSP $CLNN',
      signal: null,
      backups: [],
      symbols: ['PN', 'CNSP', 'CLNN'],
    };
    const merged = mergeAndDedupe([sparse, fat]);
    expect(merged).toHaveLength(1);
    expect(merged[0].body.length).toBeGreaterThan(0);
    expect(merged[0].title).toBe('Pre-Market Prep');
  });

  it('does NOT collapse two distinct alerts on the same day', () => {
    const a: ModeratorPost = {
      title: 'Daily Market Profits Alert 5-5-2026',
      kind: 'alert',
      author: 'Tim Bohen',
      postedAt: '2026-05-05T13:30:00.000Z',
      body: '$BLZE',
      signal: null,
      backups: [],
      symbols: ['BLZE'],
    };
    const b: ModeratorPost = {
      title: 'Daily Market Profits Alert 5-5-2026 (afternoon)',
      kind: 'alert',
      author: 'Tim Bohen',
      postedAt: '2026-05-05T18:00:00.000Z',
      body: '$VRDN',
      signal: null,
      backups: [],
      symbols: ['VRDN'],
    };
    const merged = mergeAndDedupe([a, b]);
    expect(merged).toHaveLength(2);
  });
});

describe('classify guards against page-nav titles', () => {
  it('does NOT classify a bare "Pre-Market Prep" without a date as pre_market_prep', () => {
    // The page-nav left rail and the room dropdown both render the literal
    // string "Pre-Market Prep" — without a date suffix this is a link, not
    // a post. parseModeratorAlertText must not pick it up as a title.
    const text = `Pre-Market Prep
Some random page chrome
Type
DMP
Tim Bohen
May 5, 2026 4:37 AM
`;
    const posts = parseModeratorAlertText(text);
    // Either zero posts or none classified as pre_market_prep.
    expect(posts.find((p) => p.kind === 'pre_market_prep')).toBeUndefined();
  });

  it('classifies real prep titles like "Pre Market Prep Note 5-5-2026"', () => {
    const text = `Pre Market Prep Note 5-5-2026
Watching $PN signal $6.01
Type
DMP
Tim Bohen
May 5, 2026 4:37 AM
`;
    const posts = parseModeratorAlertText(text);
    const prep = posts.find((p) => p.kind === 'pre_market_prep');
    expect(prep).toBeDefined();
    expect(prep?.title).toContain('5-5-2026');
  });
});

describe('parseModeratorAlertText nav-menu and empty-body guards', () => {
  // Reconstructs the exact failure mode reported in the
  // 2026-05-05-prep-note-data-quality diagnosis: a post whose body
  // ended up containing the StocksToTrade page-chrome (left-nav menu)
  // because the parser slice happened to span it.
  const navBody = [
    'Pre-Market Prep',
    'DMP Room',
    'Masterclass',
    'Pennystocking Framework 1',
    'Pennystocking Framework 2',
    'StocksToTrade Advisory',
    'University Vault',
    'StocksToTrade Platform',
    'Control Panel',
    'Download StocksToTrade',
    'Web Platform Login',
    'Tutorial Center',
    'Type',
    'DMP',
    'Tim Bohen',
    'May 5, 2026 4:37 AM',
  ].join('\n');

  it('drops a post whose body matches the nav-menu fingerprint', () => {
    const posts = parseModeratorAlertText(navBody);
    expect(posts).toHaveLength(0);
  });

  it('keeps empty-body prep posts in parse output so enrichment can fish for an Evernote URL', () => {
    const text = [
      'Pre Market Prep Note 5-5-2026',
      'Type',
      'DMP',
      'Tim Bohen',
      'May 5, 2026 4:37 AM',
    ].join('\n');
    const posts = parseModeratorAlertText(text);
    // The parser used to drop these directly. The Evernote enrichment
    // path runs against `parseModeratorAlertText` output, so dropping
    // here would shadow hydration. The deferred filter
    // `dropEmptyBodyPrepPosts` is responsible for removing posts that
    // are still empty after enrichment.
    expect(posts).toHaveLength(1);
    expect(posts[0].kind).toBe('pre_market_prep');
    expect(posts[0].body).toBe('');
  });

  it('dropEmptyBodyPrepPosts drops a still-empty prep post but preserves other kinds', () => {
    const empty: ModeratorPost = {
      title: 'Pre Market Prep Note 5-5-2026',
      kind: 'pre_market_prep',
      author: 'Tim Bohen',
      postedAt: '2026-05-05T04:37:00.000Z',
      body: '',
      signal: null,
      backups: [],
      symbols: [],
    };
    const headerOnlyDoubleDown: ModeratorPost = {
      title: 'Double Down Note 4-23-2026',
      kind: 'double_down',
      author: 'Tim Bohen',
      postedAt: '2026-04-23T10:00:00.000Z',
      body: '',
      signal: null,
      backups: [],
      symbols: [],
    };
    const hydrated: ModeratorPost = {
      title: 'Pre Market Prep Note 5-6-2026',
      kind: 'pre_market_prep',
      author: 'Tim Bohen',
      postedAt: '2026-05-06T04:30:00.000Z',
      body: 'plenty of content from Evernote',
      signal: null,
      backups: [],
      symbols: [],
    };
    const out = dropEmptyBodyPrepPosts([empty, headerOnlyDoubleDown, hydrated]);
    expect(out).toEqual([headerOnlyDoubleDown, hydrated]);
  });

  it('preserves header-only Double Down notes (legitimate moderator pattern)', () => {
    const text = [
      'Double Down Note 4-23-2026',
      'Type',
      'DMP',
      'Tim Bohen',
      'Apr 23, 2026 10:00 AM',
    ].join('\n');
    const posts = parseModeratorAlertText(text);
    expect(posts).toHaveLength(1);
    expect(posts[0].kind).toBe('double_down');
    expect(posts[0].body).toBe('');
  });
});
