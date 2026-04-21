export const ROBINHOOD_URL_BASE = 'https://robinhood.com/stocks';

export function robinhoodUrl(symbol: string): string {
  return `${ROBINHOOD_URL_BASE}/${encodeURIComponent(symbol)}`;
}

export function formatPrice(price: number | null | undefined): string {
  if (typeof price !== 'number' || Number.isNaN(price)) return '--';
  return `$${price.toFixed(2)}`;
}

export function formatPricePrecise(price: number | null | undefined): string {
  if (typeof price !== 'number' || Number.isNaN(price)) return '--';
  return `$${price.toFixed(3)}`;
}

export function formatChange(change: number | null, percent: number | null): string {
  if (change === null || percent === null) return '--';
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(2)} (${sign}${percent.toFixed(2)}%)`;
}

export function formatPct(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '--';
  return `${value.toFixed(2)}%`;
}

export function getChangeColor(change: number | null): string {
  if (change === null) return 'text-gray-500';
  if (change > 0) return 'text-green-600';
  if (change < 0) return 'text-red-600';
  return 'text-gray-500';
}

export function getTrendArrow(trend: 'up' | 'down' | 'flat' | null): { arrow: string; color: string } {
  if (trend === null) return { arrow: '', color: '' };
  if (trend === 'up') return { arrow: '▲', color: 'text-green-600' };
  if (trend === 'down') return { arrow: '▼', color: 'text-red-600' };
  return { arrow: '–', color: 'text-gray-400' };
}

export function scoreColor(score: number): string {
  if (score >= 75) return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (score >= 60) return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-slate-700 bg-slate-100 border-slate-200';
}

export function setupLabel(setup: string): string {
  switch (setup) {
    case 'red_candle_theory':
      return 'Red Candle Theory';
    case 'momentum_continuation':
      return 'Momentum Continuation';
    case 'pullback_reclaim':
      return 'Pullback Reclaim';
    case 'crowded_extension_watch':
      return 'Crowded Extension Watch';
    case 'orb_breakout':
      return 'Opening Range Breakout';
    default:
      return setup;
  }
}
