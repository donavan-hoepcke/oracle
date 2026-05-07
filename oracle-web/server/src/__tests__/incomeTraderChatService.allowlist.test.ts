import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      incomeTraderChat: {
        enabled: false,
        url: '',
        poll_interval_sec: 60,
        hydration_wait_ms: 0,
      },
      moderatorChatAllowlist: ['STT- Shirley', 'Tim Bohen'],
      playwright: { chrome_cdp_url: '' },
    },
  },
}));

// `messageService.ingest` is a side effect we want to count but not assert on
// here; this test focuses on the allowlist -> moderatorAlertService path.
vi.mock('../services/messageService.js', () => ({
  messageService: {
    ingest: vi.fn(),
    getRecent: vi.fn(() => []),
    getSymbolContext: vi.fn(() => ({})),
  },
}));

import { incomeTraderChatService } from '../services/incomeTraderChatService.js';
import { moderatorAlertService } from '../services/moderatorAlertService.js';
import type { ModeratorPost } from '../services/moderatorAlertService.js';

const BLZE_DD =
  'Double Down Alert 5-5-2026 $BLZE(7.76/+13.12%) Killer looking vwap hold ' +
  'Signal: $7.79 Risk Zone; $7.55 Target: $8.50+';

describe('incomeTraderChatService — moderator chat allowlist', () => {
  let captured: ModeratorPost[][];
  let unsub: () => void;

  beforeEach(() => {
    captured = [];
    unsub = moderatorAlertService.onAlerts((posts) => {
      captured.push(posts);
    });
  });

  afterEach(() => {
    unsub();
  });

  it("re-emits an STT-Shirley Double Down chat as a kind='double_down' mod_alert", () => {
    incomeTraderChatService.ingestChat([
      {
        author: 'STT- Shirley',
        postedAt: '2026-05-05T18:48:36Z',
        body: BLZE_DD,
      },
    ]);
    // moderatorAlertService.onAlerts may be invoked once with the lifted post.
    const lifted = captured.flat();
    expect(lifted).toHaveLength(1);
    expect(lifted[0].kind).toBe('double_down');
    expect(lifted[0].author).toBe('STT- Shirley');
    expect(lifted[0].signal?.symbol).toBe('BLZE');
    expect(lifted[0].signal?.signal).toBe(7.79);
  });

  it('does NOT lift chat from non-allowlisted authors even if structurally valid', () => {
    incomeTraderChatService.ingestChat([
      {
        author: 'random_trader',
        postedAt: '2026-05-05T18:50:00Z',
        body: BLZE_DD,
      },
    ]);
    expect(captured.flat()).toHaveLength(0);
  });

  it('does NOT lift an allowlisted authors casual chatter without alert shape', () => {
    incomeTraderChatService.ingestChat([
      {
        author: 'STT- Shirley',
        postedAt: '2026-05-05T19:00:00Z',
        body: 'morning all, watching the open',
      },
    ]);
    expect(captured.flat()).toHaveLength(0);
  });

  it('dedupes — re-ingesting the same chat does not double-emit', () => {
    // Use a unique postedAt so this test is independent of state leaked from
    // earlier tests (the service singleton carries chat-hash dedup across the
    // file's test cases).
    const m = {
      author: 'STT- Shirley',
      postedAt: '2026-05-05T20:15:00Z',
      body: BLZE_DD,
    };
    incomeTraderChatService.ingestChat([m]);
    incomeTraderChatService.ingestChat([m]);
    incomeTraderChatService.ingestChat([m]);
    // Chat-side dedup (incomeTraderChatService.ingestedChatHashes) only
    // re-emits new messages, so allowlist lift fires once.
    expect(captured.flat()).toHaveLength(1);
  });
});
