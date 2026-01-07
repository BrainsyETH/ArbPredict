// Core types and interfaces for the arbitrage bot

export type Platform = 'polymarket' | 'kalshi';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'FOK' | 'GTC' | 'GTD';
export type OperatingMode = 'dry_run' | 'live';
export type MatchMethod = 'exact' | 'fuzzy' | 'manual';
export type AlertLevel = 'critical' | 'high' | 'medium';

export type FailureType =
  | 'EXECUTION_FAILURE'
  | 'ASYMMETRIC_EXECUTION'
  | 'CONNECTION_LOST'
  | 'RATE_LIMIT_EXCEEDED'
  | 'DAILY_LOSS_LIMIT';

// Order Book Types
export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: Date;
}

export interface OrderBookUpdate {
  platform: Platform;
  marketId: string;
  book: OrderBook;
}

// Market Types
export interface BaseMarket {
  id: string;
  title: string;
  description?: string;
  endDate: Date;
  volume: number;
}

export interface PolymarketMarket extends BaseMarket {
  conditionId: string;
  questionId: string;
  outcomes: string[];
  outcomePrices: number[];
  tokens: {
    yes: string;
    no: string;
  };
  liquidity: number;
}

export interface KalshiMarket extends BaseMarket {
  ticker: string;
  eventTicker: string;
  category: string;
  yesPrice: number;
  noPrice: number;
  openInterest: number;
  expirationTime: Date;
  settlementTime: Date;
}

// Event Mapping
export interface EventMapping {
  id: string;
  polymarketConditionId: string;
  kalshiTicker: string;
  eventDescription: string;
  matchConfidence: number;
  resolutionDate: Date;
  matchMethod: MatchMethod;
  outcomeMapping: OutcomeMapping[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface OutcomeMapping {
  polymarketOutcome: string;
  kalshiSide: 'yes' | 'no';
}

// Order Types
export interface LimitOrder {
  platform: Platform;
  marketId: string;
  side: OrderSide;
  price: number;
  quantity: number;
  orderType: OrderType;
}

export interface FOKOrderParams {
  orderType: 'FOK';
  price: number;
  quantity: number;
  timeoutMs: number;
  maxSlippage: number;
}

export interface OrderResult {
  success: boolean;
  orderId: string;
  fillPrice?: number;
  fillQuantity?: number;
  fees?: number;
  timestamp: Date;
  error?: string;
}

// Arbitrage Types
export interface ArbitrageOpportunity {
  id: string;
  timestamp: Date;
  eventMapping: EventMapping;
  buyPlatform: Platform;
  buyPrice: number;
  buyQuantity: number;
  sellPlatform: Platform;
  sellPrice: number;
  sellQuantity: number;
  grossSpread: number;
  estimatedFees: number;
  netProfit: number;
  maxQuantity: number;
  executionRisk: number;
  expirationTime: Date;
}

export interface ExecutionResult {
  success: boolean;
  buyExecution: OrderResult | null;
  sellExecution: OrderResult | null;
  actualProfit: number;
  slippage: number;
  errors?: string[];
  circuitBreakerTriggered: boolean;
  dryRun?: boolean;
}

// Position Types
export interface Position {
  id: string;
  platform: Platform;
  eventId: string;
  eventMappingId?: string;
  side: 'yes' | 'no';
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  openedAt: Date;
  updatedAt: Date;
}

export interface InventoryReport {
  eventId: string;
  polymarketYesQty: number;
  polymarketNoQty: number;
  kalshiYesQty: number;
  kalshiNoQty: number;
  netPosition: number;
  imbalanceUsd: number;
  needsRebalancing: boolean;
}

// Risk Types
export interface RiskCheck {
  approved: boolean;
  reasons?: string[];
  warnings?: string[];
  suggestedQuantity?: number;
}

export interface ExposureReport {
  eventId: string;
  totalExposure: number;
  polymarketExposure: number;
  kalshiExposure: number;
  unrealizedPnL: number;
}

// Balances
export interface Balances {
  platform: Platform;
  available: number;
  locked: number;
  total: number;
  currency: string;
}

// Health Types
export interface HealthReport {
  polymarket: {
    connected: boolean;
    uptime: number;
    lastHeartbeat: Date | null;
  };
  kalshi: {
    connected: boolean;
    uptime: number;
    lastHeartbeat: Date | null;
  };
  allHealthy: boolean;
}

// State Persistence
export interface PersistedState {
  dailyPnL: number;
  dailyTradeCount: number;
  dailyVolumeUsd: number;
  tradingDate: string;
  circuitBreakerPaused: boolean;
  circuitBreakerReason: string | null;
  circuitBreakerPausedAt: string | null;
  openPositions: Position[];
  lastHeartbeat: string;
  lastSuccessfulTrade: string | null;
}

// Startup Check
export interface StartupCheckResult {
  canStart: boolean;
  requiresManualReview: boolean;
  checks: string[];
  warnings: string[];
}

// Profit Calculation
export interface ProfitCalculation {
  grossProfit: number;
  polymarketFees: number;
  kalshiFees: number;
  gasCost: number;
  netProfit: number;
  profitPercentage: number;
}

// Alert Types
export interface Alert {
  type: string;
  level: AlertLevel;
  message: string;
  timestamp: Date;
  data?: Record<string, unknown>;
}

// WebSocket Types
export interface ReconnectionPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

// Retry Types
export interface RetryPolicy {
  maxRetries: number;
  retryDelayMs: number;
  backoffMultiplier: number;
  maxRetryDelayMs: number;
  retryableErrors: string[];
}
