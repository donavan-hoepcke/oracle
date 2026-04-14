# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Python-based algorithmic stock trading scanner suite with three components:
- **Oracle** (`oracle/`) - Real-time stock price monitor GUI (Tkinter)
- **Premarket Scanners** (`premarket/scanners/`) - Premarket volume and ignition pattern scanners
- **ORB Trader** (`orb_trader/`) - Placeholder for future ORB trading logic

## Running the Applications

### Oracle (Price Monitor GUI)
```bash
cd oracle
pip install -r requirements.txt
python stock_monitor.py
```

### Premarket Ignition Scanner
```bash
cd premarket/scanners/premarket_ignition
pip install -r requirements.txt

# LIVE mode (Alpaca)
python premarket_ignition.py --mode live --data-source alpaca --universe universe.txt --journal journal.csv

# LIVE mode (Polygon)
python premarket_ignition.py --mode live --data-source polygon --universe universe.txt --journal journal.csv

# BACKTEST mode
python premarket_ignition.py --mode backtest --start-date 2026-01-01 --end-date 2026-01-29 --universe universe.txt --journal backtest.csv

# Parameter tuning
--vol-mult 6.0 --early-move-cap 0.15 --min-liq-vol 80000 --require-vwap 1
```

### Simple Premarket Scanner
```bash
cd premarket/scanners/premarket
pip install -r requirements.txt
python premarket.py
```

### Debug Utility
```bash
cd premarket/scanners/premarket_ignition
python debug_ticker_data.py  # Tests API connectivity and data format
```

## Architecture

### Data Flow Pattern
All scanners follow: **Config/Universe → Data Source → Pattern Detection → Alert/Journal**

### Key Abstractions (premarket_ignition.py)
- `BarDataSource` (ABC) - Abstract interface for market data providers
- `AlpacaDataSource` / `PolygonDataSource` - Concrete implementations
- `ScanParams` - Frozen dataclass with algorithm parameters
- `AlertState` - Per-symbol tracking for active alerts
- `PremarketIgnitionScanner` - Main orchestrator

### Oracle Components (stock_monitor.py)
- Dual data sources: Finnhub (primary real-time) and yfinance (fallback)
- `SoundPlayer` - Thread-safe audio alert queue
- Market hours awareness via `zoneinfo` (US/Eastern)

## Configuration

### Environment Variables (.env)
```bash
APCA_API_KEY_ID=...        # Alpaca API key
APCA_API_SECRET_KEY=...    # Alpaca secret
APCA_DATA_FEED=iex         # 'iex' (free) or 'sip' (paid)
POLYGON_API_KEY=...        # Optional Polygon.io key
WEBHOOK_URL=...            # Optional Discord webhook
```

### Oracle Config (config.yaml)
- `provider`: "finnhub" or "yfinance"
- `finnhub_api_key`: API key for real-time quotes
- `check_interval`: Polling interval in seconds (default 30)
- `alert_threshold`: Price proximity trigger (default 0.03 = 3%)

### Watchlists
- `tickers.txt` / `universe.txt`: One symbol per line, or `SYMBOL,TARGET_PRICE` format for Oracle

## Key Patterns

- **Append-only CSV journaling**: Events logged to `*_journal.csv` files
- **Incremental VWAP**: Computed bar-by-bar via `compute_intraday_vwap()`
- **Outcome tracking**: Multi-horizon exit evaluation at 10/20/30 min post-alert
- **Backtesting as testing**: No unit test suite; backtest mode validates logic against historical data

## Python Version

Requires Python 3.13+ (uses `zoneinfo`, modern type syntax like `X | None`)
