import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from parent directory (oracle-web/.env)
loadDotenv({ path: resolve(__dirname, '../../.env') });

const configSchema = z.object({
  watchlist_dir: z.string(),
  check_interval: z.number().positive().default(30),
  alert_threshold: z.number().positive().default(0.03),
  ticker_source: z.enum(['excel', 'playwright']).default('excel'),
  bot: z
    .object({
      poll_interval_sec: z.number().positive().default(30),
      playwright: z
        .object({
          start_url: z.string().default(''),
          symbols_selector: z.string().default('[data-symbol], .ticker, .symbol'),
          headless: z.boolean().default(false),
        })
        .default({}),
    })
    .default({}),
  market_hours: z.object({
    open: z.string().regex(/^\d{2}:\d{2}$/),
    close: z.string().regex(/^\d{2}:\d{2}$/),
    timezone: z.string().default('America/New_York'),
  }),
  port: z.number().positive().default(3001),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const configPath = resolve(__dirname, '../config.yaml');
  const configFile = readFileSync(configPath, 'utf-8');
  const rawConfig = parseYaml(configFile);
  return configSchema.parse(rawConfig);
}

export const config = loadConfig();

export const finnhubApiKey = process.env.FINNHUB_API_KEY || '';
export const polygonApiKey = process.env.POLYGON_API_KEY || '';
export const alpacaApiKeyId = process.env.APCA_API_KEY_ID || '';
export const alpacaApiSecretKey = process.env.APCA_API_SECRET_KEY || '';
export const alpacaDataFeed = process.env.APCA_DATA_FEED || 'iex';

if (!finnhubApiKey) {
  console.warn('Warning: FINNHUB_API_KEY not set in environment');
}

const hasBarDataSource = !!polygonApiKey || !!alpacaApiKeyId;
if (!hasBarDataSource) {
  console.warn('Warning: No bar data source configured (POLYGON_API_KEY or APCA_API_KEY_ID) - stair-step signals disabled');
}

// Stair-step trend box configuration
export const stairStepConfig = {
  enabled: !!polygonApiKey || !!alpacaApiKeyId,
  ema_period: 9,
  atr_period: 14,
  htf_ema_period: 20,
  box_lookback: 30,
  box_height_atr_mult: 0.8,
  min_containment_bars: 12,
  breakout_atr_mult: 0.15,
  min_relative_volume: 1.5,
  require_above_vwap: false,
};
