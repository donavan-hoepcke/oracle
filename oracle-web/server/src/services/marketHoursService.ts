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

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
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
    nextChange = `Market opens Monday at ${config.market_hours.open} ET`;
  } else if (currentMinutes < openMinutes) {
    nextChange = `Market opens at ${config.market_hours.open} ET`;
  } else if (currentMinutes >= closeMinutes) {
    nextChange = `Market opens tomorrow at ${config.market_hours.open} ET`;
  } else {
    nextChange = `Market closes at ${config.market_hours.close} ET`;
  }

  return {
    isOpen,
    currentTime: formatTime(zonedNow),
    openTime: config.market_hours.open,
    closeTime: config.market_hours.close,
    nextChange,
  };
}

export function isMarketOpen(): boolean {
  return getMarketStatus().isOpen;
}
