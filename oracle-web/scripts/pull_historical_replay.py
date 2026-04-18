#!/usr/bin/env python3
"""Build a cycle-level JSONL recording from real 1-min bars.

Reads Oracle level snapshots (Support / Signal / Resistance) from the daily
xlsx in F:/oracle_data, fetches matching 1-min bars from Alpaca, and writes
a JSONL file in the same format the live recording service produces so it
can be replayed through the backtest runner.

Usage:
    python pull_historical_replay.py --day 2026-02-03
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import requests

ORACLE_DATA = Path('F:/oracle_data')
RECORDINGS_DIR = ORACLE_DATA / 'recordings'
ET = ZoneInfo('America/New_York')
ENV_FILE = Path(__file__).resolve().parents[1] / '.env'


def load_env() -> None:
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _num(v) -> float | None:
    try:
        x = float(v)
        return None if pd.isna(x) else round(x, 4)
    except (TypeError, ValueError):
        return None


def _parse_float_millions(v) -> float | None:
    if not isinstance(v, str):
        return None
    s = v.strip()
    if not s:
        return None
    mult = {'K': 0.001, 'M': 1.0, 'B': 1000.0}.get(s[-1].upper())
    try:
        return float(s[:-1]) * mult if mult else float(s)
    except ValueError:
        return None


def read_levels(day: str) -> dict[str, dict]:
    d = datetime.strptime(day, '%Y-%m-%d')
    path = ORACLE_DATA / (d.strftime('%d-%b-%Y') + '.xlsx')
    df = pd.read_excel(path, header=0)
    out: dict[str, dict] = {}
    for _, row in df.iterrows():
        sym = row.get('Symbol')
        if not isinstance(sym, str) or not sym.strip():
            continue
        out[sym.strip()] = {
            'stopPrice': _num(row.get('Support')),
            'buyZonePrice': _num(row.get('Signal')),
            'sellZonePrice': _num(row.get('Resistance')),
            'floatMillions': _parse_float_millions(row.get('Float')),
        }
    return out


def fetch_bars(
    symbols: list[str], day: str, api_key: str, api_secret: str, feed: str
) -> dict[str, list[dict]]:
    base_day = datetime.strptime(day, '%Y-%m-%d')
    start = base_day.replace(hour=9, minute=30, tzinfo=ET)
    end = base_day.replace(hour=16, minute=0, tzinfo=ET)
    headers = {'APCA-API-KEY-ID': api_key, 'APCA-API-SECRET-KEY': api_secret}
    params = {
        'symbols': ','.join(symbols),
        'timeframe': '1Min',
        'start': start.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'end': end.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'feed': feed,
        'limit': 10000,
        'adjustment': 'raw',
    }
    bars_by_sym: dict[str, list[dict]] = {s: [] for s in symbols}
    while True:
        r = requests.get(
            'https://data.alpaca.markets/v2/stocks/bars',
            headers=headers,
            params=params,
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        for sym, bars in (data.get('bars') or {}).items():
            bars_by_sym.setdefault(sym, []).extend(bars)
        token = data.get('next_page_token')
        if not token:
            return bars_by_sym
        params['page_token'] = token


def _parse_bar_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


def build_cycles(day: str, levels: dict, bars_by_sym: dict[str, list[dict]]) -> list[dict]:
    symbols = sorted(levels.keys())
    bars_lookup = {
        s: {_parse_bar_ts(b['t']): b for b in bars_by_sym.get(s, [])}
        for s in symbols
    }

    base = datetime.strptime(day, '%Y-%m-%d').replace(hour=9, minute=30, tzinfo=ET)
    end = datetime.strptime(day, '%Y-%m-%d').replace(hour=15, minute=59, tzinfo=ET)
    ts_range = pd.date_range(base, end, freq='1min', tz=ET).to_pydatetime()

    day_open: dict[str, float | None] = {s: None for s in symbols}
    last_close: dict[str, float | None] = {s: None for s in symbols}
    candidate_fired: dict[str, bool] = {s: False for s in symbols}

    cycles: list[dict] = []
    for ts_et in ts_range:
        ts_utc = ts_et.astimezone(timezone.utc)
        items = []
        decisions = []
        for sym in symbols:
            lv = levels[sym]
            bar = bars_lookup[sym].get(ts_utc)

            if bar is not None:
                close = float(bar['c'])
                vol = int(bar['v'])
                if day_open[sym] is None:
                    day_open[sym] = float(bar['o'])
                prior = last_close[sym]
                last_close[sym] = close
                dopen = day_open[sym]
                change_pct = (close - dopen) / dopen if dopen else None
                current = round(close, 4)
                last_seen_price = round(prior, 4) if prior is not None else current
                max_vol = vol
            elif last_close[sym] is not None:
                current = round(last_close[sym], 4)
                last_seen_price = current
                change_pct = None
                max_vol = None
            else:
                continue

            trend: str
            if change_pct is None:
                trend = 'flat'
            elif change_pct > 0.005:
                trend = 'up'
            elif change_pct < -0.005:
                trend = 'down'
            else:
                trend = 'flat'

            items.append({
                'symbol': sym,
                'currentPrice': current,
                'lastPrice': last_seen_price,
                'changePercent': round(change_pct, 6) if change_pct is not None else None,
                'stopPrice': lv['stopPrice'],
                'buyZonePrice': lv['buyZonePrice'],
                'sellZonePrice': lv['sellZonePrice'],
                'profitDeltaPct': None,
                'maxVolume': max_vol,
                'premarketVolume': None,
                'relativeVolume': None,
                'floatMillions': lv['floatMillions'],
                'signal': None,
                'trend30m': trend,
                'boxTop': None,
                'boxBottom': None,
            })

            if (
                bar is not None
                and not candidate_fired[sym]
                and lv['buyZonePrice'] is not None
                and lv['stopPrice'] is not None
                and lv['sellZonePrice'] is not None
                and lv['buyZonePrice'] > lv['stopPrice']
                and current >= lv['buyZonePrice']
            ):
                decisions.append({
                    'symbol': sym,
                    'kind': 'candidate',
                    'setup': 'oracle_zone',
                    'score': 80,
                    'rationale': [
                        f"price {current} crossed buy zone {lv['buyZonePrice']}"
                    ],
                })
                candidate_fired[sym] = True

        cycles.append({
            'ts': ts_utc.isoformat().replace('+00:00', 'Z'),
            'tsEt': ts_et.strftime('%H:%M:%S'),
            'tradingDay': day,
            'marketStatus': {'isOpen': True, 'openTime': '09:30', 'closeTime': '16:00'},
            'items': items,
            'decisions': decisions,
            'activeTrades': [],
            'closedTrades': [],
        })
    return cycles


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--day', required=True, help='YYYY-MM-DD')
    args = ap.parse_args()

    if not DATE_RE.match(args.day):
        sys.exit(f'Invalid --day: {args.day} (expected YYYY-MM-DD)')

    load_env()
    api_key = os.environ.get('APCA_API_KEY_ID')
    api_secret = os.environ.get('APCA_API_SECRET_KEY')
    feed = os.environ.get('APCA_DATA_FEED', 'iex')
    if not api_key or not api_secret:
        sys.exit('APCA_API_KEY_ID / APCA_API_SECRET_KEY not set')

    levels = read_levels(args.day)
    symbols = sorted(levels.keys())
    print(f'xlsx: {len(symbols)} symbols', file=sys.stderr)

    bars = fetch_bars(symbols, args.day, api_key, api_secret, feed)
    total_bars = sum(len(b) for b in bars.values())
    print(f'alpaca: {total_bars} bars across {len(symbols)} symbols', file=sys.stderr)

    cycles = build_cycles(args.day, levels, bars)
    cand_count = sum(1 for c in cycles for d in c['decisions'] if d['kind'] == 'candidate')
    print(f'cycles: {len(cycles)}, candidates emitted: {cand_count}', file=sys.stderr)

    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    out = RECORDINGS_DIR / f'{args.day}.jsonl'
    with out.open('w', encoding='utf-8') as f:
        for c in cycles:
            f.write(json.dumps(c) + '\n')
    print(f'wrote {out}', file=sys.stderr)


import re  # noqa: E402
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


if __name__ == '__main__':
    main()
