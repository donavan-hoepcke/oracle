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
          // Periodically force-reload the Oracle tab so we don't accumulate
          // stale data from cached HTML, drifted JS state, or a tab the
          // browser de-prioritized while idle. 0 disables.
          reload_interval_minutes: z.number().int().nonnegative().default(60),
        })
        .default({}),
      floatmap: z
        .object({
          enabled: z.boolean().default(false),
          url: z.string().default('https://university.stockstotrade.com/page/Oracle-FloatMAP'),
          poll_interval_sec: z.number().positive().default(120),
          frame_url_contains: z.string().default('amplifyapp.com'),
          hydration_wait_ms: z.number().int().nonnegative().default(8_000),
          frame_max_wait_ms: z.number().int().nonnegative().default(30_000),
        })
        .default({}),
      moderatorAlerts: z
        .object({
          enabled: z.boolean().default(false),
          url: z.string().default('https://university.stockstotrade.com/room/daily-market-profits'),
          poll_interval_sec: z.number().positive().default(180),
          hydration_wait_ms: z.number().int().nonnegative().default(5_000),
        })
        .default({}),
      incomeTraderChat: z
        .object({
          enabled: z.boolean().default(false),
          url: z
            .string()
            .default('https://university.stockstotrade.com/room/daily-income-trader-chat'),
          poll_interval_sec: z.number().positive().default(60),
          hydration_wait_ms: z.number().int().nonnegative().default(5_000),
        })
        .default({}),
    })
    .default({}),
  execution: z
    .object({
      enabled: z.boolean().default(false),
      paper: z.boolean().default(true),
      risk_per_trade: z.number().positive().default(100),
      max_trade_cost: z.number().nonnegative().default(0),
      max_positions: z.number().int().positive().default(8),
      max_capital_pct: z.number().min(0.01).max(1).default(0.5),
      max_daily_drawdown_pct: z.number().min(0.01).max(1).default(0.05),
      max_risk_pct: z.number().min(0.01).max(1).default(0.1),
      red_candle_vol_mult: z.number().positive().default(1.5),
      momentum_gap_pct: z.number().min(0).max(1).default(0.03),
      momentum_max_chase_pct: z.number().min(0).max(1).default(0.05),
      orb_enabled: z.boolean().default(true),
      orb_range_minutes: z.number().int().positive().default(15),
      orb_volume_mult: z.number().positive().default(1.3),
      orb_max_chase_pct: z.number().min(0).max(1).default(0.03),
      orb_min_range_pct: z.number().min(0).max(1).default(0.01),
      cooldown_after_stop_ms: z.number().int().nonnegative().default(24 * 60 * 60 * 1000),
      require_uptrend_for_momentum: z.boolean().default(true),
      wash_sale_lookback_days: z.number().int().nonnegative().default(30),
      wash_sale_min_score: z.number().min(0).max(100).default(75),
      wash_sale_min_rr: z.number().positive().default(3.0),
      wash_sale_require_no_chase: z.boolean().default(true),
      trailing_breakeven_r: z.number().positive().default(1.0),
      trailing_start_r: z.number().positive().default(2.0),
      trailing_distance_r: z.number().positive().default(1.0),
      // MFE-based give-back lock: once peak R crosses trailing_mfe_activate_r,
      // the stop is pulled up so we give back at most trailing_mfe_giveback_pct
      // of the peak unrealized gain.
      trailing_mfe_activate_r: z.number().positive().default(0.5),
      trailing_mfe_giveback_pct: z.number().min(0).max(1).default(0.5),
      eod_flatten_time: z.string().regex(/^\d{2}:\d{2}$/).default('15:50'),
      float_rotation: z
        .object({
          enabled: z.boolean().default(true),
          // Flat bonus for any symbol on the FloatMAP list — "worth a look".
          score_bump_base: z.number().default(10),
          // Extra bonus when rotation lands in the prime band (active enough
          // to fuel continuation, not so hot it's blowing off).
          score_bump_prime: z.number().default(5),
          prime_band_min: z.number().nonnegative().default(1.0),
          prime_band_max: z.number().positive().default(3.0),
          // Hard veto when rotation exceeds blow-off threshold.
          veto_rotation_max: z.number().positive().default(7.0),
          // Stale-data guard — silent scraper outages should not leak old
          // rotation values into today's decisions.
          max_age_seconds: z.number().int().positive().default(600),
        })
        .default({}),
      sector_hotness: z
        .object({
          enabled: z.boolean().default(true),
          // Top K sectors by today's % change get the score bump.
          top_k_sectors: z.number().int().positive().default(3),
          score_bump: z.number().default(8),
          // Polling cadence — sector ETF data doesn't move minute-to-minute.
          refresh_interval_seconds: z.number().int().positive().default(300),
          // Stale-data guard. If the last successful poll is older than this,
          // skip the bump (silent failure shouldn't leak).
          max_age_seconds: z.number().int().positive().default(900),
          // 1m bar lookback used to compute today's session move on each ETF.
          // 480 = 8h, comfortably covers regular hours so post-close polls
          // still see the session open as the first bar.
          lookback_minutes: z.number().int().positive().default(480),
        })
        .default({}),
      regime: z
        .object({
          enabled: z.boolean().default(false),
          score_weight: z.number().min(0).max(50).default(10),
          market_weight: z.number().min(0).max(1).default(0.5),
          sector_weight: z.number().min(0).max(1).default(0.2),
          ticker_weight: z.number().min(0).max(1).default(0.3),
          spy_trend_normalize_pct: z.number().positive().default(0.005),
          vxx_roc_normalize_pct: z.number().positive().default(0.05),
          sector_trend_normalize_pct: z.number().positive().default(0.01),
          veto_market_spy_trend_pct: z.number().max(0).default(-0.01),
          veto_market_vxx_roc_pct: z.number().positive().default(0.05),
          veto_graveyard_min_sample: z.number().int().positive().default(5),
          veto_exhaustion_atr_ratio: z.number().positive().default(3.0),
          winrate_min_sample: z.number().int().positive().default(3),
          atr_penalty_ratio: z.number().positive().default(2.5),
          sector_etf_bars_lookback_min: z.number().int().positive().default(30),
          trade_history_max_trades: z.number().int().positive().default(20),
          trade_history_max_calendar_days: z.number().int().positive().default(30),
        })
        .default({}),
    })
    .default({}),
  market_hours: z.object({
    open: z.string().regex(/^\d{2}:\d{2}$/),
    close: z.string().regex(/^\d{2}:\d{2}$/),
    timezone: z.string().default('America/New_York'),
  }),
  broker: z
    .object({
      // Selects the active broker adapter at startup. Phase 1 only
      // implements 'alpaca'; Phase 2 adds 'ibkr'.
      active: z.enum(['alpaca', 'ibkr']).default('alpaca'),
      alpaca: z
        .object({
          // Cash account vs margin account at the broker. Margin remains
          // the default since Alpaca paper simulates margin trading.
          // Setting this true on a true cash account will let
          // tradeFilterService use settledCash for sizing (Phase 3).
          cash_account: z.boolean().default(false),
        })
        .default({}),
      ibkr: z
        .object({
          /** Base URL of the local Client Portal Gateway. Default matches
           *  IBKR's documented localhost-listening port for the gateway. */
          base_url: z.string().default('https://localhost:5000/v1/api'),
          /** IBKR account ID, e.g. "DU1234567" (paper) or "U1234567" (live).
           *  Read from APCA_AI_KEY_ID-style env var rather than committed
           *  config — left empty here so misconfiguration is loud. */
          account_id: z.string().default(''),
          /** Cash vs margin. Set true for a real cash account so settled-cash
           *  sizing kicks in (Phase 3). */
          cash_account: z.boolean().default(true),
          /** Tickle interval. The gateway tears the session down after
           *  ~1 minute of silence. */
          poll_session_keepalive_sec: z.number().positive().default(60),
          /** Where to persist the symbol → conid cache. Lazy-resolved on
           *  first lookup; survives process restarts. */
          conid_cache_path: z.string().default('.ibkr-state/conid-cache.json'),
          /** When the gateway uses self-signed TLS (the default for local
           *  installs), node-fetch refuses to connect. Set true ONLY for
           *  the local-gateway case. */
          allow_self_signed_tls: z.boolean().default(true),
        })
        .default({}),
    })
    .default({}),
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
