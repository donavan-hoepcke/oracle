# Incidents and findings from stock_o_bot — 2026-05-07

Written 2026-05-07 by the stock_o_bot side. Today the bot's day-plan synthesis came up empty for the second day in a row, and the diagnostic walk-back surfaced multiple issues on oracle-web's side. This doc consolidates them so oracle-web can prioritize.

This is a one-direction handoff — stock_o_bot has shipped its workarounds (PRs #68 and #69 on stock_o_bot's side) and is asking oracle-web to review and act.

## ⏳ Hand-off status

**Oracle-web side: BUILDING (Issue 1 in flight; Issue 2/3 status updated below).**

Triage by oracle-web, 2026-05-07:

- **Issue 1 — symbol-detail hangs under concurrency.** Root cause confirmed: `ruleEngineService.getRankedCandidates` re-runs `evaluateStock` over the full ~40-symbol watchlist on every call (each firing 1–2 Alpaca bar fetches). 12 concurrent `/api/raw/symbols/:sym` requests = ~480+ Alpaca fetches queued behind the IEX rate limiter. PR coming with inflight dedupe + 5s service-level cache so concurrent callers share one ranking.
- **Issue 2 — prep-note empty.** Already shipped today: PR #98 (Evernote-Lite hydration polling), PR #99 (failure TTL + age-gate), PR #100 (extract `<a href>` from anchors so the URL reaches enrichment at all — this was the active blocker). Watcher running against today's prep; will follow up with whether body crosses the 300-char hydration threshold.
- **Issue 3 — mod_alert lifetime dedup.** Already shipped: PR #96 (24h TTL on `seenModAlertKeys` + snapshot-on-subscribe so a fresh WS subscriber sees today's prep regardless of buffer rollover). Bot's `Last-Event-ID: 0` + journal-cursor workarounds are now belt-and-suspenders rather than load-bearing. No further oracle-web work needed unless you see a regression.

When Issue 1 is shipped + verified I'll flip back to **DONE — verification probes welcome**.

The three issues below are independent — fix any subset.

---

## Issue 1 (NEW today, blocking) — `/api/raw/symbols/:sym` hangs under any concurrency

`scripts/probe_oracle_moderator.py` on the bot side fired 12 concurrent requests against `http://localhost:3001/api/raw/symbols/:sym` and **all 12 timed out at 15s**. Earlier in the same session a single-shot AAPL request also hung after one previously-successful request. The `/api/raw/scanner` endpoint, in contrast, responded immediately (returned 20 items in milliseconds).

That breaks every bot tool that depends on per-symbol detail: `get_symbol_state`, `get_premarket_levels`, `get_session_vwap`, `get_float_and_dilution` — which are the four highest-value tools on the read surface. Sonnet escalations will time out trying to enrich a symbol.

Suspected causes (oracle-web side knows the codebase better):

- The on-demand Alpaca 1m-bar fetch added in PR #95 (`sessionLevelsService` for premarket + session VWAP) may be running per-request without sharing in-flight promises. Every parallel request triggers its own Alpaca call → rate-limit stall or deadlock when the IEX free-tier 200/min cap is hit.
- The Playwright browser used for moderator scraping might be holding a global lock that the symbol-detail handler also touches.
- The 30s cache from PR #95 might have a thundering-herd hole where N concurrent first-fetches all fire before the cache populates.

**Reproduce** with the probe (from stock_o_bot repo root):
```powershell
cd F:\github\stock_o_bot
.\.venv\Scripts\Activate.ps1
python scripts/probe_oracle_moderator.py
```
Expect: 12 ReadTimeout errors. If oracle-web has been freshly restarted, the first 1–2 requests succeed; subsequent ones hang.

**What we'd like:** in-flight request coalescing (single Alpaca fetch per `(symbol, session_date)` key, second-and-later concurrent requests await the same promise). 30s cache TTL stays. Or if there's an existing pattern in oracle-web for slow-fetch coalescing, use that.

## Issue 2 (RECURRING) — prep-note body is empty every time

Today's `python -m stock_o_bot plan-day` printed `warning: no pre_market_prep mod_alert found for 2026-05-07`. Investigation: the bot has *never* journaled a prep-note with a non-empty body. Every `kind=pre_market_prep` event in the journal — across all dates — has `body_len = 0`.

Sample of the most recent five (all `body_len=0`):
```
2026-05-05  posted_at=2026-04-23  title='Pre Market Prep Note 4-23-2026'  body_len=0
2026-05-05  posted_at=2026-04-24  title='Pre Market Prep Note 4-24-2026'  body_len=0
2026-05-05  posted_at=2026-04-27  title='Pre Market Prep Note 4-27-2026'  body_len=0
2026-05-05  posted_at=2026-04-28  title='Pre Market Prep Note 4-28-2026'  body_len=0
2026-05-05  posted_at=2026-04-29  title='Pre Market Prep Note 4-29-2026'  body_len=0
```

The title classification is fine — `PREP_TITLE_RE` matches today's `"Pre Market Prep Note 5-7-2026"` cleanly. The body-extraction step (`enrichWithEvernoteBody` → falling back to whatever `parseModeratorAlertText` produced) is the failure point.

This issue has been known since 2026-05-05 and was documented in the bot repo at `stock_o_bot/docs/agent-feedback/2026-05-05-prep-note-data-quality.md` with three layers diagnosed:

1. (FIXED bot-side) Fetcher race-tied to received_at picked the empty stub when a populated sibling existed in the same poll.
2. (NOT FIXED) Two parallel scraper paths produced parallel records — one with the canonical title (always empty body), one with a generic shorter title (sometimes populated with chrome).
3. (NOT FIXED) When body *was* captured, it was the StocksToTrade left-nav menu and announcements strip, not the post content.

The fact that today returned zero mod_alerts at all (different failure mode — see Issue 3) prevents us from confirming whether 2 and 3 are still active. But the historical journal makes clear the body-capture has not actually been working at any point we have data for.

**What we'd like:** verify on oracle-web's side what `parseModeratorAlertText` and `enrichWithEvernoteBody` produce for today's `https://university.stockstotrade.com/room/pre-market-prep` page. If the Evernote enrichment is failing silently, the post body falls back to the in-page stub which apparently is just the title + the link. Possible fixes:

- Better extraction: target a specific DOM container for the post body rather than `document.body.innerText`. The 401-char "body" we logged on 2026-05-05 was the page's left-nav menu plus the announcements strip — the parser was picking up too high a DOM ancestor.
- If Evernote enrichment is the intended body source: add error logging that surfaces when `evernoteService.fetchNote(url)` returns null/empty so we can see *why* the enrichment is dropping the body.
- A `dropEmptyBodyPrepPosts` log line is good (and exists), but doesn't help if no upstream caller checks it. The bot can't see oracle-web stdout.

A debug endpoint that exposes `moderatorAlertService.getSnapshot()` directly (current `posts` array, raw, no per-symbol reshape) would let stock_o_bot probe the parser state remotely. Right now the only exposure is the per-symbol `detail.moderator` view, which doesn't show parser failures.

## Issue 3 (RECURRING) — mod_alert lifetime dedup blocks new subscribers

Already documented in detail at `stock_o_bot/docs/agent-feedback/2026-05-07-oracle-mod-alert-dedup.md` — please refer to that doc for the root cause + three suggested fix options (TTL on the dedup set / snapshot-on-subscribe / daily clear).

Today's manifestation: bot started up at 08:25 ET, oracle-web's first scrape cycle had already published today's prep (back to an empty buffer-slot, pre-bot), `seenModAlertKeys` marked it as "seen", so even after stock_o_bot's PR #68 (always send `Last-Event-ID`) and PR #69 (resume from journal cursor), the bot couldn't recover the post — it had rolled out of the 1000-event ring buffer hours before the bot connected.

Bot-side workarounds in place:

- **PR #68** — always send `Last-Event-ID` header on connect, even when 0. Server's `replaySince(0)` returns the full ring buffer.
- **PR #69** — seed the WS client cursor from `MAX(events.source_id)` at startup, so a restart resumes from the actual gap rather than blindly replaying 1000 events.

These reduce the failure surface but don't close it. The oracle-web fix (Option 1, 2, or 3 in the existing handoff doc) would.

## Priority

If you have time for one thing, **Issue 1** is the most blocking — it makes every Sonnet escalation slow or fail today regardless of the other two issues. If you have time for two, do **Issue 1 + Issue 2** so plan-day can actually use a populated prep note when one arrives. Issue 3 is the long-tail resilience fix.

## Verification

For each issue, run from the stock_o_bot repo root:

```powershell
cd F:\github\stock_o_bot
.\.venv\Scripts\Activate.ps1

# Issue 1: per-symbol endpoint under concurrency
python scripts/probe_oracle_moderator.py

# Issue 2: any prep note ever journaled with a non-empty body?
python -c "
import sqlite3, json
conn = sqlite3.connect('stock_o_bot.sqlite')
total = 0
populated = 0
for (pj,) in conn.execute(\"SELECT payload_json FROM events WHERE type='mod_alert' AND payload_json LIKE '%pre_market_prep%'\"):
    try:
        p = json.loads(pj)
    except (json.JSONDecodeError, TypeError):
        continue
    if p.get('kind') != 'pre_market_prep':
        continue
    total += 1
    body_len = len(p.get('body') or p.get('body_excerpt') or '')
    if body_len > 0:
        populated += 1
print(f'prep notes total: {total}; with non-empty body: {populated}')
"

# Issue 3: see existing handoff doc for verification probe.
```

Expected on success: probe runs to completion (no timeouts), prep-note populated count > 0, dedup-set check from existing handoff passes.
