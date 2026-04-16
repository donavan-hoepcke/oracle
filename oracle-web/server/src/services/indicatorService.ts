// Generic bar interface that works with both Polygon and Alpaca bars
export interface Bar {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Calculates Exponential Moving Average for an array of closes
 */
export function calculateEMA(closes: number[], period: number): number[] {
  if (closes.length === 0 || period <= 0) return [];

  const ema: number[] = [];
  const multiplier = 2 / (period + 1);

  // First EMA value is SMA
  let sum = 0;
  for (let i = 0; i < Math.min(period, closes.length); i++) {
    sum += closes[i];
  }
  ema.push(sum / Math.min(period, closes.length));

  // Calculate subsequent EMAs
  for (let i = 1; i < closes.length; i++) {
    const prevEma = ema[i - 1];
    const newEma = (closes[i] - prevEma) * multiplier + prevEma;
    ema.push(newEma);
  }

  return ema;
}

/**
 * Calculates Average True Range
 */
export function calculateATR(bars: Bar[], period: number): number[] {
  if (bars.length < 2 || period <= 0) return [];

  const trueRanges: number[] = [];

  // First TR is just high - low
  trueRanges.push(bars[0].high - bars[0].low);

  // Calculate true range for remaining bars
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = bars[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  // Calculate ATR using EMA of true ranges
  return calculateEMA(trueRanges, period);
}

/**
 * Calculates intraday VWAP (Volume Weighted Average Price)
 */
export function calculateVWAP(bars: Bar[]): number[] {
  if (bars.length === 0) return [];

  const vwap: number[] = [];
  let cumulativeVolume = 0;
  let cumulativeVolumePrice = 0;

  for (const bar of bars) {
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    cumulativeVolume += bar.volume;
    cumulativeVolumePrice += typicalPrice * bar.volume;

    if (cumulativeVolume > 0) {
      vwap.push(cumulativeVolumePrice / cumulativeVolume);
    } else {
      vwap.push(typicalPrice);
    }
  }

  return vwap;
}

/**
 * Calculates relative volume compared to average
 */
export function calculateRelativeVolume(
  volumes: number[],
  avgPeriod: number = 20
): number {
  if (volumes.length === 0) return 0;
  if (volumes.length === 1) return 1;

  const currentVolume = volumes[volumes.length - 1];

  // Calculate average of previous bars (excluding current)
  const lookback = Math.min(avgPeriod, volumes.length - 1);
  if (lookback === 0) return 1;

  let sum = 0;
  for (let i = volumes.length - 1 - lookback; i < volumes.length - 1; i++) {
    sum += volumes[i];
  }
  const avgVolume = sum / lookback;

  if (avgVolume === 0) return 0;
  return currentVolume / avgVolume;
}

/**
 * Checks if EMA is rising over the last n bars
 */
export function isEmaRising(emaValues: number[], lookback: number = 3): boolean {
  if (emaValues.length < 2) return false;

  const start = Math.max(0, emaValues.length - lookback);
  for (let i = start + 1; i < emaValues.length; i++) {
    if (emaValues[i] <= emaValues[i - 1]) {
      return false;
    }
  }
  return true;
}
