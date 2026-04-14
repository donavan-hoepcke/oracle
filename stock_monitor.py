"""
Real-Time Stock Monitor GUI (with Thread-Safe Audio)

Monitors a list of stock tickers and their target prices in real time.
Uses the Finnhub API (true real-time) or yfinance (fallback) for market data,
and displays results in a Tkinter GUI with automatic desktop + audio alerts.

Features:
    - True real-time quotes (Finnhub)
    - Thread-safe sound queue (prevents crash on overlapping alerts)
    - Auto-reload of config.yaml and tickers.txt
    - Auto-generated alert.wav (1s sine chime)
    - Bright-green highlight when targets are hit
    - Double-click ticker to open Robinhood chart

Author: ChatGPT (OpenAI)
Version: 2.0
Compatible: Python 3.13+
"""

import os
import time
import math
import struct
import queue
import threading
import webbrowser
import tkinter as tk
from tkinter import ttk
from datetime import datetime
from zoneinfo import ZoneInfo
import yaml
import simpleaudio as sa
from plyer import notification
import pandas as pd

# Optional imports
try:
    import finnhub
except ImportError:
    finnhub = None
import yfinance as yf

CONFIG_FILE = "config.yaml"


# ----------------------------------------------------------
# Configuration and file helpers
# ----------------------------------------------------------

def load_config() -> dict:
    """Load configuration from config.yaml."""
    if not os.path.exists(CONFIG_FILE):
        raise FileNotFoundError("Missing config.yaml")
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def parse_hhmm(s: str) -> tuple[int, int]:
    """Parse a time string (HH:MM)."""
    hh, mm = s.split(":")
    return int(hh), int(mm)


def is_market_open(cfg: dict) -> bool:
    """
    Check if the market is currently open based on config hours.
    """
    mh = cfg.get("market_hours", {})
    tz = ZoneInfo(mh.get("timezone", "America/New_York"))
    now = datetime.now(tz)
    oh, om = parse_hhmm(mh.get("open", "09:30"))
    ch, cm = parse_hhmm(mh.get("close", "16:00"))
    open_dt = now.replace(hour=oh, minute=om, second=0, microsecond=0)
    close_dt = now.replace(hour=ch, minute=cm, second=0, microsecond=0)
    return open_dt <= now <= close_dt


def get_excel_path(data_dir: str) -> str:
    """
    Get path to today's Excel file (dd-mmm-yyyy.xlsx format).
    """
    tz = ZoneInfo("America/New_York")
    today = datetime.now(tz)
    filename = today.strftime("%d-%b-%Y") + ".xlsx"
    return os.path.join(data_dir, filename)


def load_watchlist(path: str) -> dict:
    """
    Load tickers and target prices from Excel file.
    Reads Symbol (column E) and Long Signal (column F).
    Only includes rows where Long Signal has a value.
    """
    wl = {}
    if not os.path.exists(path):
        print(f"Watchlist file not found: {path}")
        return wl
    try:
        df = pd.read_excel(path, header=0)
        # Rename columns to handle duplicate 'Signal' names
        df.columns = ['Min', 'Support', 'Short Delta', 'Short Signal', 'Symbol',
                      'Long Signal', 'Long Delta', 'Resistance', 'Max', 'Last',
                      'Pct Chg', 'Volume', 'Float', 'Mk Cap']
        # Filter rows with Long Signal values
        signals = df[df['Long Signal'].notna()]
        for _, row in signals.iterrows():
            symbol = str(row['Symbol']).strip().upper()
            target = float(row['Long Signal'])
            wl[symbol] = target
    except Exception as e:
        print(f"Error loading Excel watchlist: {e}")
    return wl


# ----------------------------------------------------------
# Alert sound generator
# ----------------------------------------------------------

def ensure_default_wav(path: str, seconds: float = 1.0,
                       freq: float = 880.0, vol: float = 0.4) -> None:
    """
    Create a 1s sine wave WAV file if missing.
    """
    if os.path.exists(path):
        return
    sr = 44100
    n = int(seconds * sr)
    frames = bytearray()
    for i in range(n):
        t = i / sr
        env = min(1.0, i / (0.02 * sr)) * min(1.0, (n - i) / (0.03 * sr))
        sample = int(32767 * vol * env * math.sin(2 * math.pi * freq * t))
        frames += struct.pack("<h", sample)
    import wave
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(frames)


# ----------------------------------------------------------
# Thread-safe sound system
# ----------------------------------------------------------

class SoundPlayer:
    """
    Thread-safe sound playback manager.

    Serializes playback requests via a queue to prevent
    crashes when multiple alerts fire close together.
    """

    def __init__(self, sound_path: str):
        self.sound_path = sound_path
        self.queue = queue.Queue()
        self.running = True
        self.thread = threading.Thread(target=self._sound_loop, daemon=True)
        self.thread.start()

    def play(self):
        """Queue a sound playback request."""
        if self.sound_path and os.path.exists(self.sound_path):
            try:
                self.queue.put_nowait(True)
            except queue.Full:
                pass

    def _sound_loop(self):
        """Background loop that plays sounds sequentially."""
        while self.running:
            try:
                _ = self.queue.get(timeout=0.5)
                sa.WaveObject.from_wave_file(self.sound_path).play()
                time.sleep(0.2)
            except queue.Empty:
                continue
            except Exception as e:
                print(f"[SoundPlayer] Warning: {e}")

    def stop(self):
        """Stop playback thread."""
        self.running = False


# ----------------------------------------------------------
# Data providers
# ----------------------------------------------------------

def get_price_finnhub(client, ticker: str) -> float | None:
    """Fetch latest real-time price from Finnhub."""
    try:
        q = client.quote(ticker)
        return float(q.get("c")) or None
    except Exception as e:
        print(f"Finnhub error {ticker}: {e}")
        return None


def get_price_yf(ticker: str) -> float | None:
    """Fetch latest intraday price using yfinance (delayed)."""
    try:
        data = yf.Ticker(ticker).history(period="1d", interval="1m")
        if data is not None and not data.empty:
            return float(data["Close"].iloc[-1])
    except Exception as e:
        print(f"yfinance error {ticker}: {e}")
    return None


# ----------------------------------------------------------
# Alerts and notifications
# ----------------------------------------------------------

def notify_desktop(app_name: str, ticker: str,
                   current: float, target: float) -> None:
    """Send desktop notification."""
    link = f"https://robinhood.com/stocks/{ticker}"
    notification.notify(
        title=f"🚨 {ticker} hit target!",
        message=f"Current: ${current:.2f} (Target: ${target:.2f})\n{link}",
        timeout=10,
        app_name=app_name or "Stock Monitor",
    )


def alert_user(app_name: str, ticker: str,
               current: float, target: float,
               sound_player: SoundPlayer | None) -> None:
    """
    Execute full alert (console print, desktop notification, sound).
    """
    print(f"[ALERT] {ticker} hit ${target:.2f} (Current ${current:.2f})")
    notify_desktop(app_name, ticker, current, target)
#    if sound_player:
#        sound_player.play()


# ----------------------------------------------------------
# GUI update loop
# ----------------------------------------------------------

def update_prices_loop(
        tree: ttk.Treeview,
        alerted: set,
        status_lbl: tk.Label,
        sound_player: SoundPlayer,
        alert_percentage: float,
        app_name: str) -> None:
    """
    Periodically fetch prices, update GUI, and trigger alerts.
    """
    cfg = load_config()
    data_dir = cfg.get("watchlist_dir", "F:/oracle_data")
    wl_path = get_excel_path(data_dir)
    print(f"Loading watchlist from: {wl_path}")
    wl = load_watchlist(wl_path)

    # Setup provider
    provider = cfg.get("provider", "yfinance").lower()
    finnhub_client = None
    if provider == "finnhub" and finnhub and cfg.get("finnhub_api_key"):
        finnhub_client = finnhub.Client(api_key=cfg["finnhub_api_key"])
        print("✅ Using Finnhub real-time data")
    else:
        print("⚠️ Falling back to yfinance (delayed)")

    # Populate initial rows
    for tkr, tgt in wl.items():
        tree.insert("", "end", values=(tkr, f"${tgt:.2f}", "..."), tags=("neutral",))

    wl_mtime = os.path.getmtime(wl_path) if os.path.exists(wl_path) else 0
    last_wl_path = wl_path

    while True:
        start = time.time()
        if not is_market_open(cfg):
            status_lbl.config(text="Market closed. Sleeping…")
            time.sleep(15)
            continue

        # Check if date changed (new Excel file) or file was modified
        current_wl_path = get_excel_path(data_dir)
        new_mtime = os.path.getmtime(current_wl_path) if os.path.exists(current_wl_path) else 0
        if current_wl_path != last_wl_path or new_mtime != wl_mtime:
            wl_path = current_wl_path
            last_wl_path = wl_path
            wl = load_watchlist(wl_path)
            wl_mtime = new_mtime
            for iid in tree.get_children():
                tree.delete(iid)
            for tkr, tgt in wl.items():
                tgt_max = tgt * (1 + alert_percentage)
                tree.insert("", "end", values=(tkr, f"${tgt:.2f} - ${tgt_max:.2f}", "..."), tags=("neutral",))
            alerted.clear()  # Reset alerts for new day/file
            status_lbl.config(text=f"Loaded watchlist ({len(wl)} signals)")

        hits = 0
        for tkr, tgt in wl.items():
            price = (get_price_finnhub(finnhub_client, tkr)
                     if finnhub_client else get_price_yf(tkr))
            if price is None:
                continue

            tgt_max = tgt * (1 + alert_percentage)

            hit = price >= tgt and price <= tgt_max
            tag = "hit" if hit else "neutral"

            for iid in tree.get_children():
                if tree.item(iid, "values")[0] == tkr:
                    tree.item(iid,
                              values=(tkr, f"${tgt:.2f} - ${tgt_max:.2f}", f"${price:.2f}"),
                              tags=(tag,))
                    break

            if hit and tkr not in alerted:
                alert_user(app_name, tkr, price, tgt, sound_player)
                alerted.add(tkr)
                hits += 1

        status_lbl.config(text=f"Updated {len(wl)} tickers • Alerts: {hits}")
        interval = int(cfg.get("check_interval", 10))
        time.sleep(max(1, interval - (time.time() - start)))


# ----------------------------------------------------------
# GUI setup
# ----------------------------------------------------------

def main() -> None:
    """Launch Tkinter GUI and start monitoring thread."""
    cfg = load_config()
    sound_path = cfg.get("alert_sound", "alert.wav")
    ensure_default_wav(sound_path)
    sound_player = SoundPlayer(sound_path)

    alert_percentage = cfg.get("alert_threshold", 3.0)
    app_name = cfg.get("app_name", "Stock Monitor")

    root = tk.Tk()
    root.title("📈 Real-Time Stock Monitor")

    top = ttk.Frame(root)
    top.pack(fill="x", padx=10, pady=(10, 0))
    status_lbl = ttk.Label(top, text="Starting…")
    status_lbl.pack(side="left")

    tree = ttk.Treeview(root, columns=("Ticker", "Target Range", "Current"),
                        show="headings", height=30)
    for col, text, w in [("Ticker", "Ticker", 120),
                         ("Target Range", "Target Range", 140),
                         ("Current", "Current Price", 140)]:
        tree.heading(col, text=text)
        tree.column(col, width=w,
                    anchor="center" if col == "Ticker" else "e")
    tree.pack(fill="both", expand=True, padx=10, pady=10)

    style = ttk.Style(root)
    style.configure("Treeview", font=("Segoe UI", 11))
    tree.tag_configure("neutral", background="white")
    tree.tag_configure("hit", background="#90ee90")

    def on_double_click(event):
        """Open Robinhood chart on double-click."""
        item = tree.identify_row(event.y)
        if item:
            ticker = tree.item(item, "values")[0]
            webbrowser.open(f"https://robinhood.com/stocks/{ticker}")

    tree.bind("<Double-1>", on_double_click)

    alerted = set()
    threading.Thread(
        target=update_prices_loop,
        args=(tree, alerted, status_lbl, sound_player, alert_percentage, app_name),
        daemon=True).start()

    def on_close():
        """Graceful shutdown."""
        try:
            sound_player.stop()
        except Exception:
            pass
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    root.mainloop()


if __name__ == "__main__":
    main()
