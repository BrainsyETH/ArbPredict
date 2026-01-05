import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { config as loadEnv } from 'dotenv';
import type { OperatingMode, ReconnectionPolicy, RetryPolicy } from '../types/index.js';

// Load environment variables
loadEnv();

export interface RiskConfig {
  maxExposurePerEvent: number;
  maxTotalExposure: number;
  maxPositionImbalance: number;
  minProfitThreshold: number;
  maxSlippageTolerance: number;
  minLiquidityDepth: number;
  dailyLossLimit: number;
  perTradeLossLimit: number;
  maxQuantityPerTrade: number;
  minQuantityPerTrade: number;
  maxConsecutiveFailures: number;
  maxAsymmetricExecutions: number;
}

export interface MatchingConfig {
  minConfidenceThreshold: number;
  exactMatchConfidence: number;
  fuzzyMatchMinSimilarity: number;
  requireDateValidation: boolean;
  requireCategoryMatch: boolean;
}

export interface SmallPositionConfig {
  minTradeValueUsd: number;
  minProfitUsd: number;
  estimatedGasCostUsd: number;
  maxGasAsPercentOfTrade: number;
}

export interface RateLimitConfig {
  polymarket: {
    marketDataPerMinute: number;
    ordersPerMinute: number;
    minRequestIntervalMs: number;
  };
  kalshi: {
    readPerSecond: number;
    writePerSecond: number;
    minRequestIntervalMs: number;
  };
  backoff: {
    initialDelayMs: number;
    maxDelayMs: number;
    multiplier: number;
  };
}

export interface LatencyConfig {
  orderbookFetchTargetMs: number;
  orderbookFetchMaxMs: number;
  orderPlacementTargetMs: number;
  orderPlacementMaxMs: number;
  opportunityDetectionTargetMs: number;
  opportunityDetectionMaxMs: number;
  endToEndMaxMs: number;
}

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
  alertLevels: string[];
}

export interface DatabaseConfig {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
}

export interface Config {
  // Platform credentials
  polymarket: {
    apiKey: string;
    privateKey: string;
    rpcUrl: string;
    clobApiUrl: string;
    wsUrl: string;
  };
  kalshi: {
    email: string;
    password: string;
    apiBase: string;
    wsUrl: string;
  };

  // Trading parameters
  trading: {
    minProfitThreshold: number;
    maxPositionPerEvent: number;
    maxTotalExposure: number;
    minLiquidity: number;
    maxSlippage: number;
    executionTimeoutMs: number;
    orderType: 'FOK';
  };

  // Risk management
  risk: RiskConfig;

  // Event matching
  matching: MatchingConfig;

  // Small position settings
  smallPosition: SmallPositionConfig;

  // Rate limiting
  rateLimits: RateLimitConfig;

  // Latency thresholds
  latency: LatencyConfig;

  // WebSocket
  websocket: ReconnectionPolicy;

  // Retry configuration
  retry: {
    opportunity: RetryPolicy;
    api: RetryPolicy;
  };

  // Operating mode
  operatingMode: {
    mode: OperatingMode;
    logOpportunities: boolean;
    simulateExecutions: boolean;
    trackHypotheticalPnL: boolean;
  };

  // State persistence
  state: {
    filePath: string;
    autoSaveIntervalSeconds: number;
  };

  // Crash recovery
  crashRecovery: {
    requireManualReview: boolean;
    queryPositionsOnStartup: boolean;
    maxStateAgeMinutes: number;
  };

  // Telegram
  telegram: TelegramConfig;

  // Database
  database: DatabaseConfig;

  // Logging
  logging: {
    level: string;
    file: string;
    maxSizeMb: number;
    maxFiles: number;
  };
}

function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value;
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

export function loadConfig(): Config {
  // Try to load from config.yaml if it exists
  let yamlConfig: Partial<Config> = {};
  const configPath = './config.yaml';

  if (existsSync(configPath)) {
    try {
      const yamlContent = readFileSync(configPath, 'utf-8');
      yamlConfig = parseYaml(yamlContent);
    } catch {
      console.warn('Failed to parse config.yaml, using environment variables only');
    }
  }

  // Build config with environment variable overrides
  const config: Config = {
    polymarket: {
      apiKey: getEnvOrDefault('POLYMARKET_API_KEY', ''),
      privateKey: getEnvOrDefault('POLYMARKET_PRIVATE_KEY', ''),
      rpcUrl: getEnvOrDefault('POLYMARKET_RPC_URL', 'https://polygon-rpc.com'),
      clobApiUrl: 'https://clob.polymarket.com',
      wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    },

    kalshi: {
      email: getEnvOrDefault('KALSHI_EMAIL', ''),
      password: getEnvOrDefault('KALSHI_PASSWORD', ''),
      apiBase: 'https://trading-api.kalshi.com/trade-api/v2',
      wsUrl: 'wss://trading-api.kalshi.com/trade-api/ws/v2',
    },

    trading: {
      minProfitThreshold: 0.03,
      maxPositionPerEvent: 100,
      maxTotalExposure: 100,
      minLiquidity: 50,
      maxSlippage: 0.01,
      executionTimeoutMs: 1000,
      orderType: 'FOK',
    },

    risk: {
      maxExposurePerEvent: 100,
      maxTotalExposure: 100,
      maxPositionImbalance: 10,
      minProfitThreshold: 0.03,
      maxSlippageTolerance: 0.01,
      minLiquidityDepth: 50,
      dailyLossLimit: 20,
      perTradeLossLimit: 10,
      maxQuantityPerTrade: 50,
      minQuantityPerTrade: 1,
      maxConsecutiveFailures: 3,
      maxAsymmetricExecutions: 1,
    },

    matching: {
      minConfidenceThreshold: 0.95,
      exactMatchConfidence: 1.0,
      fuzzyMatchMinSimilarity: 0.95,
      requireDateValidation: true,
      requireCategoryMatch: true,
    },

    smallPosition: {
      minTradeValueUsd: 5,
      minProfitUsd: 0.10,
      estimatedGasCostUsd: 0.01,
      maxGasAsPercentOfTrade: 0.02,
    },

    rateLimits: {
      polymarket: {
        marketDataPerMinute: 60,
        ordersPerMinute: 30,
        minRequestIntervalMs: 1000,
      },
      kalshi: {
        readPerSecond: 5,
        writePerSecond: 2,
        minRequestIntervalMs: 500,
      },
      backoff: {
        initialDelayMs: 1000,
        maxDelayMs: 32000,
        multiplier: 2,
      },
    },

    latency: {
      orderbookFetchTargetMs: 100,
      orderbookFetchMaxMs: 500,
      orderPlacementTargetMs: 200,
      orderPlacementMaxMs: 1000,
      opportunityDetectionTargetMs: 50,
      opportunityDetectionMaxMs: 200,
      endToEndMaxMs: 2000,
    },

    websocket: {
      maxAttempts: 5,
      initialDelayMs: 1000,
      maxDelayMs: 30000,
      backoffMultiplier: 2,
      heartbeatIntervalMs: 5000,
      heartbeatTimeoutMs: 30000,
    },

    retry: {
      opportunity: {
        maxRetries: 1,
        retryDelayMs: 500,
        backoffMultiplier: 1,
        maxRetryDelayMs: 500,
        retryableErrors: ['NETWORK_TIMEOUT', 'RATE_LIMIT_SOFT'],
      },
      api: {
        maxRetries: 3,
        retryDelayMs: 1000,
        backoffMultiplier: 2,
        maxRetryDelayMs: 8000,
        retryableErrors: [
          'NETWORK_TIMEOUT',
          'RATE_LIMIT_SOFT',
          'CONNECTION_RESET',
          'HTTP_500',
          'HTTP_502',
          'HTTP_503',
          'HTTP_504',
        ],
      },
    },

    operatingMode: {
      mode: (getEnvOrDefault('TRADING_MODE', 'dry_run') as OperatingMode),
      logOpportunities: true,
      simulateExecutions: true,
      trackHypotheticalPnL: true,
    },

    state: {
      filePath: './data/bot_state.json',
      autoSaveIntervalSeconds: 30,
    },

    crashRecovery: {
      requireManualReview: true,
      queryPositionsOnStartup: true,
      maxStateAgeMinutes: 60,
    },

    telegram: {
      enabled: getEnvBool('TELEGRAM_ENABLED', false),
      botToken: getEnvOrDefault('TELEGRAM_BOT_TOKEN', ''),
      chatId: getEnvOrDefault('TELEGRAM_CHAT_ID', ''),
      alertLevels: ['critical', 'high'],
    },

    database: {
      host: getEnvOrDefault('DB_HOST', 'localhost'),
      port: getEnvNumber('DB_PORT', 5432),
      name: getEnvOrDefault('DB_NAME', 'arb_bot'),
      user: getEnvOrDefault('DB_USER', 'postgres'),
      password: getEnvOrDefault('DB_PASSWORD', ''),
    },

    logging: {
      level: getEnvOrDefault('LOG_LEVEL', 'info'),
      file: './logs/arb_bot.log',
      maxSizeMb: 10,
      maxFiles: 5,
    },
  };

  return config;
}

// Singleton config instance
let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

export function resetConfig(): void {
  configInstance = null;
}
