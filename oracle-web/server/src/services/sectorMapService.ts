import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { parse as parseYaml } from 'yaml';
import { finnhubApiKey } from '../config.js';

type SectorKey =
  | 'materials' | 'communications' | 'energy' | 'financials' | 'industrials'
  | 'technology' | 'software' | 'consumer_staples' | 'real_estate' | 'utilities'
  | 'healthcare' | 'consumer_discretionary' | 'biotechnology' | 'unknown';

const SECTOR_TO_ETF: Record<SectorKey, string> = {
  materials: 'XLB',
  communications: 'XLC',
  energy: 'XLE',
  financials: 'XLF',
  industrials: 'XLI',
  technology: 'XLK',
  software: 'IGV',
  consumer_staples: 'XLP',
  real_estate: 'XLRE',
  utilities: 'XLU',
  healthcare: 'XLV',
  consumer_discretionary: 'XLY',
  biotechnology: 'XBI',
  unknown: 'SPY',
};

const FINNHUB_TO_CANONICAL: Array<[RegExp, SectorKey]> = [
  [/biotech/i, 'biotechnology'],
  [/pharma|drug|medical|health|life science|hospital/i, 'healthcare'],
  [/software|semiconductor|computer/i, 'software'],
  [/technology|electronic|it services/i, 'technology'],
  [/oil|gas|energy|coal/i, 'energy'],
  [/bank|insurance|financial|capital/i, 'financials'],
  [/retail|apparel|auto|leisure|consumer discretionary|restaurants|hotels/i, 'consumer_discretionary'],
  [/food|beverage|tobacco|household|consumer staples/i, 'consumer_staples'],
  [/real estate|reit/i, 'real_estate'],
  [/utilities/i, 'utilities'],
  [/telecom|media|communication/i, 'communications'],
  [/metal|mining|chemical|material/i, 'materials'],
  [/airline|transport|machinery|industrial|aerospace|defense/i, 'industrials'],
];

function normalizeFinnhubIndustry(raw: string | null | undefined): SectorKey {
  if (!raw) return 'unknown';
  for (const [pattern, key] of FINNHUB_TO_CANONICAL) {
    if (pattern.test(raw)) return key;
  }
  return 'unknown';
}

export interface SectorMapDeps {
  overrides: Record<string, string>;
  cache: Record<string, string>;
  cachePath: string;
  finnhubKey: string;
}

export class SectorMapService {
  private overrides: Record<string, SectorKey>;
  private cache: Record<string, SectorKey>;
  private readonly cachePath: string;
  private readonly finnhubKey: string;

  constructor(deps: SectorMapDeps) {
    this.overrides = Object.fromEntries(
      Object.entries(deps.overrides).map(([k, v]) => [k.toUpperCase(), this.coerce(v)]),
    );
    this.cache = Object.fromEntries(
      Object.entries(deps.cache).map(([k, v]) => [k.toUpperCase(), this.coerce(v)]),
    );
    this.cachePath = deps.cachePath;
    this.finnhubKey = deps.finnhubKey;
  }

  private coerce(v: string): SectorKey {
    const lower = v.toLowerCase();
    return lower in SECTOR_TO_ETF ? (lower as SectorKey) : 'unknown';
  }

  getEtfFor(sector: string): string {
    const key = this.coerce(sector);
    return SECTOR_TO_ETF[key];
  }

  async getSectorFor(symbol: string): Promise<string> {
    const up = symbol.toUpperCase();
    if (this.overrides[up]) return this.overrides[up];
    if (this.cache[up]) return this.cache[up];
    if (!this.finnhubKey) return 'unknown';

    try {
      const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(up)}&token=${this.finnhubKey}`;
      const res = await fetch(url);
      if (!res.ok) return 'unknown';
      const data = (await res.json()) as { finnhubIndustry?: string };
      const sector = normalizeFinnhubIndustry(data.finnhubIndustry);
      if (sector !== 'unknown') {
        this.cache[up] = sector;
        this.persist();
      }
      return sector;
    } catch {
      return 'unknown';
    }
  }

  private persist(): void {
    if (!this.cachePath) return;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2), 'utf-8');
    } catch {
      // cache persistence is best-effort
    }
  }
}

export function loadOverridesFromYaml(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = parseYaml(raw) as { overrides?: Record<string, string> } | null;
    return parsed?.overrides ?? {};
  } catch {
    return {};
  }
}

export function loadCacheFromJson(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OVERRIDES_PATH = resolve(__dirname, '../../config/sector_overrides.yaml');
const CACHE_PATH = 'F:/oracle_data/sector_map.json';

export const sectorMapService = new SectorMapService({
  overrides: loadOverridesFromYaml(OVERRIDES_PATH),
  cache: loadCacheFromJson(CACHE_PATH),
  cachePath: CACHE_PATH,
  finnhubKey: finnhubApiKey,
});
