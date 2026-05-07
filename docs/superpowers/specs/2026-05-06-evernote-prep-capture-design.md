# Pre-Market Prep Body Capture via Evernote — Design Spec

> **Status:** Proposed. Not yet implemented.

## Context

`stock_o_bot`'s day-plan synthesis depends on the body of Bohen's pre-market prep note (tickers, signal/risk/target, backups, narrative). The current scraper captures only the title — every prep record has `body=""` in the journal, with the parser's slice landing on either an empty string or a 401-char chunk of StocksToTrade page-chrome (already mitigated in PR #89). Diagnosis: `F:\github\stock_o_bot\docs\agent-feedback\2026-05-05-prep-note-data-quality.md`.

Bohen authors the prep as an **Evernote note** and shares the public-readable link (`https://lite.evernote.com/note/<uuid>`) inside his chat-room post each morning. Following that link with Playwright lets us scrape the full body without fighting the chat-room's collapsed-post rendering.

## Goals

- When today's prep post is detected, find the embedded Evernote URL, fetch the note's body, and emit it as the `body` field on the `pre_market_prep` `ModeratorPost`.
- Cache Evernote fetches per-URL so polling every 3 minutes doesn't re-fetch the same note.
- Fall back gracefully when the Evernote link is missing or unreachable: emit the post with whatever body we did capture (today: empty), don't break the rest of the moderator-alerts pipeline.

## Non-goals

- Logging into Evernote. v1 only handles publicly-shared notes (the `lite.evernote.com` format) — the operator confirmed shares are anonymous-readable. If we ever encounter a login wall we treat it as an outage signal (see Error Handling), not a feature gap.
- Scraping arbitrary URLs from posts. Only Evernote shares are followed — preventing the bot from inadvertently following spam, ads, or off-platform links.
- Replacing the chat-room scrape. This augments the existing `moderatorAlertService` flow; alerts, double-downs, and backups continue working as-is.

## Architecture

```
moderatorAlertService.pollOnce()
  ├── fetch chat-room innerText  (existing)
  ├── parseModeratorAlertText    (existing, includes prep posts with empty body)
  ├── enrichWithEvernoteBody(posts, rawText)   ← NEW
  │     ├── for each pre_market_prep post:
  │     │     find Evernote URL in rawText near the post's title block
  │     │     if URL: fetch + cache + replace body
  │     └── (also scans non-prep raw text — Caleb sometimes pastes the
  │          Evernote link in a follow-up message; we still find it)
  ├── mergeAndDedupe              (existing)
  └── ingestPosts                 (existing)
```

The new `enrichWithEvernoteBody` step runs after parsing but before dedupe, so the post that wins the day-kind dedupe in `mergeAndDedupe` is the longest-body version (which by then is the Evernote-augmented one).

## Components

### `evernoteService.ts` (new)

Pure-ish service responsible for fetching one Evernote note and returning its body text. Uses the existing Chrome CDP attach pattern (matches `moderatorAlertService.fetchPageText`).

```ts
export interface EvernoteNote {
  url: string;
  title: string;
  body: string;
  fetchedAt: string;
}

export class EvernoteService {
  private cache = new Map<string, EvernoteNote>();
  private inFlight = new Map<string, Promise<EvernoteNote | null>>();

  async fetchNote(url: string): Promise<EvernoteNote | null>;
  /** Test seam — bypass network, seed the cache. */
  primeCache(url: string, note: EvernoteNote): void;
}
```

Fetch implementation: connect to Chrome over CDP, open the URL in a new tab, wait for the note container to render, grab `document.querySelector('.NoteEditor, .ReadOnlyEditor, [data-test-id="note-content"]')?.innerText` (selector list is best-effort — Evernote renders the content inside one of these). Return the URL, the note's title (`<h1>` inside the container), and the body text. On selector failure, fall back to `document.body.innerText` filtered for the note region (heuristic: lines between the title and the footer).

Cache is keyed on URL. A successful fetch is cached for the lifetime of the process — Bohen doesn't edit prep notes after publishing, so once we've got the body we don't need to re-fetch. Failed fetches are NOT cached (so a transient Evernote outage doesn't lock in failure for the whole day).

`inFlight` prevents the polling loop from triggering parallel fetches for the same URL during a 5-second hydration wait.

### `moderatorAlertService.ts` (modified)

Add a post-parse enrichment pass. Pseudocode:

```ts
private async enrichWithEvernoteBody(
  posts: ModeratorPost[],
  rawText: string,
): Promise<ModeratorPost[]> {
  return Promise.all(posts.map(async (post) => {
    if (post.kind !== 'pre_market_prep') return post;
    if (post.body.length > 200) return post; // already has real content
    const url = findEvernoteUrlForPost(post, rawText);
    if (!url) return post;
    const note = await evernoteService.fetchNote(url);
    if (!note) return post;
    return { ...post, body: note.body };
  }));
}
```

`findEvernoteUrlForPost` strategy:
1. Match `https://(lite\.)?evernote\.com/note/[a-f0-9-]+` anywhere in rawText.
2. Pick the URL that appears closest (by line distance) to `post.title` in rawText. If no nearby match, take the most recently posted Evernote URL (whichever appears last in the rawText, since chat is reverse-chronological).
3. If multiple candidates have similar proximity, pick the one in the post's own bodyLines slice if present.

### Config additions (`config.broker.moderatorAlerts.evernote`)

```yaml
moderatorAlerts:
  enabled: true
  urls:
    - "https://university.stockstotrade.com/room/pre-market-prep"
    - "https://university.stockstotrade.com/room/daily-market-profits"
  poll_interval_sec: 180
  hydration_wait_ms: 5000
  evernote:
    enabled: true
    hydration_wait_ms: 4000
    # Per-URL fetch cache lifetime. 24h covers the trading day and lets a
    # bot restart hydrate from cache rather than re-fetching every prep.
    cache_ttl_sec: 86400
```

## Error handling

| Failure | Behavior |
|---|---|
| Evernote URL not found in rawText | Post emitted with original (empty) body. Logged at info level. |
| Multiple Evernote URLs, ambiguous proximity | Take the closest; log all candidates at debug level. |
| Evernote page fails to load (timeout, 4xx) | Fetch returns null, post keeps original body. NOT cached so next poll retries. |
| Evernote selector returns empty / login wall detected (page contains "Sign in" text) | Same as above — null return, retry next poll. Open question: surface as `needs_human` on the ops monitor? |
| CDP connection lost mid-fetch | Fetch returns null. The chat-room scrape itself proceeds normally. |
| Evernote content is structured weirdly (tables, images) | We extract `innerText`, which preserves text in reading order. Images/embeds become empty space. |

The failure modes are designed so a broken Evernote integration NEVER worsens our existing chat-room capture: the fallback is "emit the post we already have."

## Testing

New file: `evernoteService.test.ts`.
- `fetchNote` returns cached value on second call (asserts no second Playwright invocation).
- `fetchNote` does NOT cache failures.
- Cache TTL respected (use `vi.useFakeTimers` or pass a clock).

Extend `moderatorAlertService.test.ts`:
- `enrichWithEvernoteBody` finds Evernote URL in raw text and replaces empty prep body.
- Skips when post body is already long.
- Skips for non-prep kinds.
- Picks URL closest to the post's title when multiple candidates exist.
- Falls through to original post when fetch returns null.

Integration test (manual, not automated):
- Verify on a real prep day: `curl /api/moderator-alerts | jq '.posts | map(select(.kind == "pre_market_prep") | {title, body_len: (.body | length)})'`
- Expected: today's prep has `body_len > 500` containing actual ticker prose.

## Risks & open questions

1. **Evernote login wall.** If Bohen's notes are secretly login-required (we'd discover this on first integration test), the public-fetch path returns the sign-in page HTML. Mitigation: detect "Sign in to view" in the captured text and emit a `needs_human` ops-monitor flag. Would need OAuth or a manual session-share to fix; out of scope for v1.
2. **Selector drift.** Evernote's web frontend can rev its DOM. The `.NoteEditor / .ReadOnlyEditor / [data-test-id="note-content"]` allowlist is best-effort; if all three fail we fall back to `document.body.innerText` filtered between title and a heuristic end marker. This is fragile but failure-safe (degrades to existing empty-body behavior).
3. **Performance.** A second Playwright tab per prep poll adds ~5–10 seconds of hydration wait. Cache short-circuits subsequent polls within the same day. Once the prep is captured, the cost goes to zero until next morning.
4. **Multiple prep posts per day.** If Bohen posts a "second-look" prep, we'd see two URLs. Spec assumes the most-recent one wins via `mergeAndDedupe`'s longest-body rule (the second-look is usually richer); confirm with Bohen's posting pattern in practice.
5. **Non-Evernote share URLs.** If Bohen ever switches to Notion / Google Docs / etc., this whole path breaks. The spec is intentionally Evernote-specific so it's clear what to extend later — adding a `share_followers/notion.ts` service mirrors the structure.

## Open questions (please confirm before implementation)

- a. Is the `lite.evernote.com/note/<uuid>` link Bohen posts always public-readable, or does it sometimes require login? (Determines whether v1 ships or we need OAuth first.)
- b. Should the ops monitor get a new probe (`pre_market_prep_body`) that fires red when today's prep post has empty body past 9:00 ET? (Enables operator visibility without changing scraper behavior.)
- c. After the first successful Evernote fetch caches the note, do we want a manual refresh endpoint (`POST /api/ops/refresh-evernote?url=...`) for the case where Bohen edits the note post-publish? (Probably not — Bohen rarely edits — but flag as a future-work item.)
