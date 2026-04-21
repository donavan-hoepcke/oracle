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
  check_interval: z.number().positive().default(30),
  alert_threshold: z.number().positive().default(0.03),
  bot: z
    .object({
      poll_interval_sec: z.number().positive().default(30),
      playwright: z
        .object({
          start_url: z.string().default(''),
          data_page_url: z.string().default(''),
          wait_for_selector: z.string().default(''),
          symbols_selector: z.string().default('[data-symbol], .ticker, .symbol'),
          row_selector: z.string().default(''),
          symbol_selector: z.string().default('[data-symbol], .symbol, .ticker'),
          target_selector: z.string().default(''),
          resistance_selector: z.string().default(''),
          login_required: z.boolean().default(false),
          manual_login: z.boolean().default(false),
          manual_login_timeout_sec: z.number().positive().default(300),
          persist_session: z.boolean().default(true),
          session_state_path: z.string().default('.playwright-state/oracle-session.json'),
          login_url: z.string().default(''),
          username_selector: z.string().default('input[name="username"], input[type="email"]'),
          password_selector: z.string().default('input[name="password"], input[type="password"]'),
          submit_selector: z.string().default('button[type="submit"], input[type="submit"]'),
          post_login_wait_selector: z.string().default(''),
          username_env: z.string().default('ORACLE_WEB_USERNAME'),
          password_env: z.string().default('ORACLE_WEB_PASSWORD'),
          headless: z.boolean().default(false),
          use_existing_chrome: z.boolean().default(false),
          chrome_cdp_url: z.string().default('http://127.0.0.1:9222'),
          oracle_expected_columns: z
            .array(z.string())
            .default([
              'symbol',
              'stop',
              'long',
              'stock_data',
              'symbol_2',
              'stop_loss',
              'buy_zone',
              'profit_delta',
              'sell_zone',
              'max',
              'last',
            ]),
          oracle_schema_strict: z.boolean().default(false),
        })
        .default({}),
      floatmap: z
        .object({
          enabled: z.boolean().default(false),
          url: z.string().default('https://university.stockstotrade.com/page/Oracle-FloatMAP'),
          poll_interval_sec: z.number().positive().default(120),
          frame_url_contains: z.string().default('amplifyapp.com'),
          hydration_wait_ms: z.number().int().nonnegative().default(8_000),
        })
        .default({}),
    })
    .default({}),
  execution: z
    .object({
      enabled: z.boolean().default(false),
      paper: z.boolean().default(true),
      risk_per_trade: z.number().positive().default(100),
      max_positions: z.number().int().positive().default(8),
      max_capital_pct: z.number().min(0.01).max(1).default(0.5),
      max_daily_drawdown_pct: z.number().min(0.01).max(1).default(0.05),
      max_risk_pct: z.number().min(0.01).max(1).default(0.1),
      red_candle_vol_mult: z.number().positive().default(1.5),
      momentum_gap_pct: z.number().min(0).max(1).default(0.03),
      momentum_max_chase_pct: z.number().min(0).max(1).default(0.05),
      cooldown_after_stop_ms: z.number().int().nonnegative().default(24 * 60 * 60 * 1000),
      require_uptrend_for_momentum: z.boolean().default(true),
      wash_sale_lookback_days: z.number().int().nonnegative().default(30),
      wash_sale_min_score: z.number().min(0).max(100).default(75),
      wash_sale_min_rr: z.number().positive().default(3.0),
      wash_sale_require_no_chase: z.boolean().default(true),
      trailing_breakeven_r: z.number().positive().default(1.0),
      trailing_start_r: z.number().positive().default(2.0),
      trailing_distance_r: z.number().positive().default(1.0),
      eod_flatten_time: z.string().regex(/^\d{2}:\d{2}$/).default('15:50'),
    })
    .default({}),
  market_hours: z.object({
    open: z.string().regex(/^\d{2}:\d{2}$/),
    close: z.string().regex(/^\d{2}:\d{2}$/),
    timezone: z.string().default('America/New_York'),
  }),
  recording: z
    .object({
      enabled: z.boolean().default(true),
      dir: z.string().default('F:/oracle_data/recordings'),
    })
    .default({}),
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
