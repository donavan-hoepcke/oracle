#!/usr/bin/env python3
"""Extract Oracle levels from the daily xlsx into a JSON sidecar.

The historical-replay TS script consumes this JSON so the Node side stays
free of xlsx parsing deps.

Usage:
    python extract_levels.py --day 2026-02-03
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

import pandas as pd

ORACLE_DATA = Path('F:/oracle_data')
LEVELS_DIR = ORACLE_DATA / 'levels'
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


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


def extract(day: str) -> dict:
    d = datetime.strptime(day, '%Y-%m-%d')
    path = ORACLE_DATA / (d.strftime('%d-%b-%Y') + '.xlsx')
    df = pd.read_excel(path, header=0)
    tickers: dict[str, dict] = {}
    for _, row in df.iterrows():
        sym = row.get('Symbol')
        if not isinstance(sym, str) or not sym.strip():
            continue
        tickers[sym.strip()] = {
            'stopPrice': _num(row.get('Support')),
            'buyZonePrice': _num(row.get('Signal')),
            'sellZonePrice': _num(row.get('Resistance')),
            'lastPrice': _num(row.get('Last')),
            'floatMillions': _parse_float_millions(row.get('Float')),
        }
    return {'day': day, 'tickers': tickers}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--day', required=True, help='YYYY-MM-DD')
    args = ap.parse_args()
    if not DATE_RE.match(args.day):
        sys.exit(f'Invalid --day: {args.day} (expected YYYY-MM-DD)')

    data = extract(args.day)
    LEVELS_DIR.mkdir(parents=True, exist_ok=True)
    out = LEVELS_DIR / f'{args.day}.json'
    out.write_text(json.dumps(data, indent=2), encoding='utf-8')
    print(f'wrote {out} ({len(data["tickers"])} symbols)', file=sys.stderr)


if __name__ == '__main__':
    main()
