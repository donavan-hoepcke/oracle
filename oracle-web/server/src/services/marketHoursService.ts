import { toZonedTime } from 'date-fns-tz';
import { config } from '../config.js';

export interface MarketStatus {
  isOpen: boolean;
  currentTime: string;
  openTime: string;
  closeTime: string;
  nextChange: string;
}

function parseTime(timeStr: string): { hours: number; minutes: number } {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return { hours, minutes };
}

function formatTime(utcDate: Date): string {
  // Format a real UTC Date directly with a timezone — avoids the double-conversion
  // that happens when formatting an already-zoned Date (from toZonedTime).
  return utcDate.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: config.market_hours.timezone,
  });
}

export function getMarketStatus(): MarketStatus {
  const now = new Date();
  const zonedNow = toZonedTime(now, config.market_hours.timezone);

  const day = zonedNow.getDay();
  const isWeekend = day === 0 || day === 6;

  const open = parseTime(config.market_hours.open);
  const close = parseTime(config.market_hours.close);

  const currentMinutes = zonedNow.getHours() * 60 + zonedNow.getMinutes();
  const openMinutes = open.hours * 60 + open.minutes;
  const closeMinutes = close.hours * 60 + close.minutes;

  const isWithinHours = currentMinutes >= openMinutes && currentMinutes < closeMinutes;
  const isOpen = !isWeekend && isWithinHours;

  let nextChange: string;
  if (isWeekend) {
    const daysUntilMonday = day === 0 ? 1 : 2;
    nextChange = `Market opens Monday at ${config.market_hours.open} ET (in ${daysUntilMonday} day${daysUntilMonday > 1 ? 's' : ''})`;
  } else if (currentMinutes < openMinutes) {
    nextChange = `Market opens at ${config.market_hours.open} ET`;
  } else if (currentMinutes >= closeMinutes) {
    nextChange = `Market opens tomorrow at ${config.market_hours.open} ET`;
  } else {
    nextChange = `Market closes at ${config.market_hours.close} ET`;
  }

  return {
    isOpen,
    currentTime: formatTime(now),
    openTime: config.market_hours.open,
    closeTime: config.market_hours.close,
    nextChange,
  };
}

export function isMarketOpen(): boolean {
  return getMarketStatus().isOpen;
}

/**
 * Session-aware market state used by the extended-hours RCT path.
 *
 *   'pre'    — 04:00 ET ≤ now < open  (Alpaca pre-market)
 *   'rth'    — open ≤ now < close      (regular trading hours; same as isOpen)
 *   'post'   — close ≤ now < 20:00 ET  (Alpaca post-market)
 *   'closed' — outside the above, including weekends
 *
 * Pre/post boundaries are Alpaca's documented extended-hours window. RTH
 * boundaries come from `config.market_hours.{open,close}` so the existing
 * isOpen behavior is preserved exactly.
 */
export type MarketSession = 'pre' | 'rth' | 'post' | 'closed';

const PRE_START_MINUTES = 4 * 60;        // 04:00 ET
const POST_END_MINUTES = 20 * 60;        // 20:00 ET

export function getMarketSession(now: Date = new Date()): MarketSession {
  const zoned = toZonedTime(now, config.market_hours.timezone);
  const day = zoned.getDay();
  if (day === 0 || day === 6) return 'closed';
  const open = parseTime(config.market_hours.open);
  const close = parseTime(config.market_hours.close);
  const minutes = zoned.getHours() * 60 + zoned.getMinutes();
  const openMin = open.hours * 60 + open.minutes;
  const closeMin = close.hours * 60 + close.minutes;
  if (minutes >= openMin && minutes < closeMin) return 'rth';
  if (minutes >= PRE_START_MINUTES && minutes < openMin) return 'pre';
  if (minutes >= closeMin && minutes < POST_END_MINUTES) return 'post';
  return 'closed';
}

export function isExtendedHours(now: Date = new Date()): boolean {
  const s = getMarketSession(now);
  return s === 'pre' || s === 'post';
}

/**
 * Minutes remaining until the current session ends. Returns null when
 * we're not in an active session (i.e. session === 'closed').
 * Used by tradeFilterService to refuse new entries in the last N minutes
 * of post-market — no time left to manage an exit before session end.
 */
export function minutesUntilSessionEnd(now: Date = new Date()): number | null {
  const session = getMarketSession(now);
  if (session === 'closed') return null;
  const zoned = toZonedTime(now, config.market_hours.timezone);
  const minutes = zoned.getHours() * 60 + zoned.getMinutes();
  const open = parseTime(config.market_hours.open);
  const close = parseTime(config.market_hours.close);
  const openMin = open.hours * 60 + open.minutes;
  const closeMin = close.hours * 60 + close.minutes;
  if (session === 'pre') return openMin - minutes;
  if (session === 'rth') return closeMin - minutes;
  // session === 'post'
  return POST_END_MINUTES - minutes;
}
