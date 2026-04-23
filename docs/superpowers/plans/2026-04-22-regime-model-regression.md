# Regime Regression — 2026-04-22

8-day backtest comparing regime-ON vs regime-OFF on the `docs/regime-model-design` branch, using `backtestBreakdown` with default options (starting cash $10k, 1% risk per trade).

## Setup

- Branch: `docs/regime-model-design` (includes config schema, services, rule-engine hook, filter vetos, recording schema, priceSocket wiring, historicalReplay snapshot build, backtest veto replay)
- Replay: `historicalReplay --day <d>` re-run for each of the 8 days after implementation completed
- Backtest: `backtestBreakdown` iterating all 8 days
- Baseline context: the prior `-$12.39` figure from the conversation summary was on `feat/position-sizing-clip` branch at $1k / $10 risk per trade. This branch uses $10k / $100 risk by default (scale factor ×10); direct dollar comparison is not meaningful.

## Per-day results (regime ON and OFF are identical)

| Day        | Trades | W/L | Win% | P&L      |
|------------|-------:|----:|-----:|---------:|
| 2026-02-03 |   4    | 2/2 | 50%  |  -46.18  |
| 2026-02-04 |   4    | 3/1 | 75%  | +202.92  |
| 2026-02-05 |   5    | 4/1 | 80%  | +285.97  |
| 2026-02-06 |   3    | 1/2 | 33%  |  -94.42  |
| 2026-04-17 |   3    | 1/2 | 33%  |  -46.38  |
| 2026-04-20 |   9    | 0/9 |  0%  | -795.74  |
| 2026-04-21 |  10    | 1/9 | 10%  | -759.19  |
| 2026-04-22 |  10    | 3/7 | 30%  | -451.98  |
| **Total**  | **48** | **15/33** | **31%** | **-1704.99** |

Breakdown by setup (aggregate):

| Setup                 | Trades | W/L   | Win% | P&L      | avg R  |
|-----------------------|-------:|------:|-----:|---------:|-------:|
| orb_breakout          |    9   | 5/4   | 56%  |  +164.44 |  +0.18 |
| momentum_continuation |   39   | 10/29 | 26%  | -1869.43 |  -0.48 |

## Veto effect

**Zero vetos fired across all 8 days.** The three vetos are:

- **Market panic** (SPY 30m ≤ −1% AND VXX 1d ROC ≥ +5%): neither condition hit simultaneously on these days.
- **Ticker+setup graveyard** (sampleSize ≥ 5 AND winRate = 0): no `(symbol, setup)` pair accumulated 5+ losses in the lookback window.
- **Exhaustion** (today's range ≥ 3× ATR): no qualifying parabolic moves.

## Score-contribution effect

Also **zero observable effect**. Re-running `historicalReplay` with `enabled: false` produces identical candidate counts per day (2/24/429/46/11/548/675/558 momentum, 14/29/28/19/11/46/6/34 ORB), and identical backtest P&L. The composite × 10 bump shifted scores but did not push any borderline candidate across or back over the ~65 threshold on this sample.

## Interpretation

1. **The current momentum_continuation setup is responsible for ~-$1869 of the loss across 8 days.** This setup has been rewritten on a separate branch (`feat/momentum-signal-rewrite`), which is not merged into this branch. Merging the rewrite after this PR should materially change the picture.
2. **Regime thresholds are too conservative for this dataset.** No veto fired. Consider:
   - Market panic: loosen to one-of-two (SPY OR VXX) rather than AND.
   - Graveyard: lower `veto_graveyard_min_sample` from 5 → 3 (would catch earlier).
   - Exhaustion: lower `veto_exhaustion_atr_ratio` from 3.0 → 2.0 (would catch more parabolic extensions).
   - Any of these is a one-line config change; no code change needed.
3. **The score_weight of 10 is too small relative to the ~65-point threshold.** A 10-point shift didn't reclassify any candidate. Consider raising to 15–20, or making composite exponential so strong regimes bite harder.
4. **Implementation is inert on this data, which makes it safe to ship.** Zero regression. Turning `enabled: true` would change nothing on this sample. Any future day with a real panic or exhaustion will get the intended protection.

## Decision

- **Ship with `enabled: false` default.** This preserves current trading behavior while making the layer available for toggling + tuning.
- **Next experiments** (not in this PR):
  - Merge `feat/momentum-signal-rewrite` to test regime against the quieter momentum signal.
  - Tune veto thresholds based on larger backtest datasets.
  - Consider raising `score_weight` or making composite scoring non-linear.

## Artefacts

- Replay JSONLs at `F:/oracle_data/recordings/{YYYY-MM-DD}.jsonl` for all 8 days now include the `regime` field.
- Regime-ON snapshots preserved at `{YYYY-MM-DD}.regime-on.jsonl.bak` for each day.
- Today's live run preserved at `2026-04-22.live.jsonl.bak`.
