# Polymarket ↔ Kalshi Arbitrage Bot Specification

## Executive Summary

This document specifies an automated trading system that identifies and executes arbitrage opportunities between Polymarket (crypto-native prediction market on Polygon) and Kalshi (CFTC-regulated prediction market). The bot monitors equivalent prediction markets on both platforms and executes trades when price discrepancies exceed transaction costs.

---

## 1. Market Overview

### 1.1 Polymarket
- **Chain:** Polygon (MATIC)
- **Settlement Currency:** USDC
- **Order Type:** CLOB (Central Limit Order Book) via their API
- **Fee Structure:** ~1-2% on winnings (varies)
- **API:** REST + WebSocket
- **Authentication:** Wallet signature (SIWE-style)
- **Settlement:** Automatic on-chain resolution

### 1.2 Kalshi
- **Type:** CFTC-regulated exchange
- **Settlement Currency:** USD
- **Order Type:** CLOB
- **Fee Structure:** 
  - 7% on profits (capped at $0.07/contract)
  - No fees on losses
- **API:** REST + WebSocket
- **Authentication:** API keys (OAuth2)
- **Settlement:** T+1 USD withdrawal

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        ARBITRAGE BOT                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │
│  │  Polymarket │    │   Kalshi    │    │   Event Matching    │ │
│  │  Connector  │    │  Connector  │    │      Service        │ │
│  └──────┬──────┘    └──────┬──────┘    └──────────┬──────────┘ │
│         │                  │                      │             │
│         ▼                  ▼                      ▼             │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Unified Order Book Manager                     ││
│  │         (Normalized prices, quantities, events)             ││
│  └─────────────────────────┬───────────────────────────────────┘│
│                            │                                    │
│                            ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Arbitrage Opportunity Detector                 ││
│  │    (Spread calculation, fee adjustment, profit threshold)  ││
│  └─────────────────────────┬───────────────────────────────────┘│
│                            │                                    │
│                            ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                   Execution Engine                          ││
│  │         (Order placement, fill tracking, retries)           ││
│  └─────────────────────────┬───────────────────────────────────┘│
│                            │                                    │
│                            ▼                                    │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────┐│
│  │ Position Manager │  │  Risk Manager    │  │ P&L Tracker    ││
│  └──────────────────┘  └──────────────────┘  └────────────────┘│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     INFRASTRUCTURE                              │
├─────────────────────────────────────────────────────────────────┤
│  Database (PostgreSQL)  │  Redis (Cache)  │  Monitoring/Alerts │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Components

### 3.1 Market Connectors

#### 3.1.1 Polymarket Connector

```typescript
interface PolymarketConnector {
  // WebSocket subscription for real-time orderbook
  subscribeToMarket(conditionId: string): Observable<OrderBookUpdate>;
  
  // REST endpoints
  getMarkets(): Promise<PolymarketMarket[]>;
  getOrderBook(tokenId: string): Promise<OrderBook>;
  
  // Trading
  placeLimitOrder(order: LimitOrder): Promise<OrderResult>;
  placeMarketOrder(order: MarketOrder): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  
  // Account
  getBalances(): Promise<Balances>;
  getPositions(): Promise<Position[]>;
}

interface PolymarketMarket {
  conditionId: string;
  questionId: string;
  question: string;
  outcomes: string[];        // ["Yes", "No"]
  outcomePrices: number[];   // [0.65, 0.35]
  tokens: TokenPair;         // YES and NO token addresses
  volume: number;
  liquidity: number;
  endDate: Date;
}
```

#### 3.1.2 Kalshi Connector

```typescript
interface KalshiConnector {
  // WebSocket subscription
  subscribeToMarket(ticker: string): Observable<OrderBookUpdate>;
  
  // REST endpoints
  getMarkets(params?: MarketFilters): Promise<KalshiMarket[]>;
  getOrderBook(ticker: string): Promise<OrderBook>;
  
  // Trading
  placeOrder(order: KalshiOrder): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  
  // Account
  getBalance(): Promise<number>;
  getPositions(): Promise<KalshiPosition[]>;
}

interface KalshiMarket {
  ticker: string;
  title: string;
  category: string;
  yesPrice: number;         // 0-100 cents
  noPrice: number;
  volume: number;
  openInterest: number;
  expirationTime: Date;
  settlementTime: Date;
}
```

### 3.2 Event Matching Service

The most critical component - maps equivalent events across platforms.

```typescript
interface EventMatcher {
  // Build initial mapping from known event pairs
  buildMappings(): Promise<EventMapping[]>;
  
  // Find Kalshi equivalent for a Polymarket event
  findKalshiEquivalent(polymarketId: string): KalshiMarket | null;
  
  // Confidence score for match quality
  getMatchConfidence(mapping: EventMapping): number;
  
  // Manual override for edge cases
  addManualMapping(polyId: string, kalshiTicker: string): void;
}

interface EventMapping {
  polymarketConditionId: string;
  kalshiTicker: string;
  eventDescription: string;
  matchConfidence: number;      // 0-1 score
  resolutionDate: Date;
  matchMethod: 'exact' | 'fuzzy' | 'manual';
  
  // Outcome mapping (critical for multi-outcome markets)
  outcomeMapping: {
    polymarketOutcome: string;
    kalshiSide: 'yes' | 'no';
  }[];
}
```

#### Matching Strategies

1. **Exact Title Match:** Normalize and compare event titles
2. **Fuzzy Matching:** Levenshtein distance + keyword extraction
3. **Category + Date Matching:** Same category + same resolution date
4. **Manual Curation:** Maintain a curated list of known pairs
5. **LLM-Assisted:** Use GPT/Claude to assess equivalence

```typescript
// Example matching logic
function matchEvents(polyEvent: PolymarketMarket, kalshiEvents: KalshiMarket[]): EventMapping | null {
  // Normalize titles
  const polyTitle = normalize(polyEvent.question);
  
  for (const kalshi of kalshiEvents) {
    const kalshiTitle = normalize(kalshi.title);
    
    // Exact match
    if (polyTitle === kalshiTitle) {
      return createMapping(polyEvent, kalshi, 1.0, 'exact');
    }
    
    // Fuzzy match
    const similarity = levenshteinSimilarity(polyTitle, kalshiTitle);
    if (similarity > 0.85) {
      // Additional validation: check dates align
      if (datesMatch(polyEvent.endDate, kalshi.expirationTime)) {
        return createMapping(polyEvent, kalshi, similarity, 'fuzzy');
      }
    }
  }
  
  return null;
}
```

### 3.3 Arbitrage Opportunity Detector

```typescript
interface ArbitrageDetector {
  // Continuously scan for opportunities
  scanForOpportunities(): Observable<ArbitrageOpportunity>;
  
  // Calculate profit after all fees
  calculateNetProfit(opp: ArbitrageOpportunity): ProfitCalculation;
  
  // Check if opportunity is still valid
  validateOpportunity(opp: ArbitrageOpportunity): boolean;
}

interface ArbitrageOpportunity {
  id: string;
  timestamp: Date;
  eventMapping: EventMapping;
  
  // The trade
  buyPlatform: 'polymarket' | 'kalshi';
  buyPrice: number;           // Price to buy YES
  buyQuantity: number;        // Max available at this price
  
  sellPlatform: 'polymarket' | 'kalshi';
  sellPrice: number;          // Price to sell YES (or buy NO)
  sellQuantity: number;
  
  // Economics
  grossSpread: number;        // sellPrice - buyPrice
  estimatedFees: number;
  netProfit: number;          // Per contract/share
  maxQuantity: number;        // Limited by min liquidity
  
  // Risk metrics
  executionRisk: number;      // 0-1, based on liquidity depth
  expirationTime: Date;
}

// Core arbitrage detection logic
function detectArbitrage(
  polyBook: OrderBook,
  kalshiBook: OrderBook,
  mapping: EventMapping
): ArbitrageOpportunity | null {
  
  // Normalize prices to same scale (0-1)
  const polyYesBid = polyBook.bids[0]?.price || 0;
  const polyYesAsk = polyBook.asks[0]?.price || 1;
  const kalshiYesBid = kalshiBook.bids[0]?.price / 100;  // Kalshi uses cents
  const kalshiYesAsk = kalshiBook.asks[0]?.price / 100;
  
  // Case 1: Buy on Polymarket, Sell on Kalshi
  if (polyYesAsk < kalshiYesBid) {
    const spread = kalshiYesBid - polyYesAsk;
    const fees = estimateFees('polymarket', 'kalshi', polyYesAsk, kalshiYesBid);
    
    if (spread > fees + MIN_PROFIT_THRESHOLD) {
      return {
        buyPlatform: 'polymarket',
        buyPrice: polyYesAsk,
        sellPlatform: 'kalshi',
        sellPrice: kalshiYesBid,
        grossSpread: spread,
        estimatedFees: fees,
        netProfit: spread - fees,
        // ... other fields
      };
    }
  }
  
  // Case 2: Buy on Kalshi, Sell on Polymarket
  if (kalshiYesAsk < polyYesBid) {
    const spread = polyYesBid - kalshiYesAsk;
    const fees = estimateFees('kalshi', 'polymarket', kalshiYesAsk, polyYesBid);
    
    if (spread > fees + MIN_PROFIT_THRESHOLD) {
      return {
        buyPlatform: 'kalshi',
        buyPrice: kalshiYesAsk,
        sellPlatform: 'polymarket',
        sellPrice: polyYesBid,
        grossSpread: spread,
        estimatedFees: fees,
        netProfit: spread - fees,
        // ... other fields
      };
    }
  }
  
  return null;
}
```

### 3.4 Fee Calculation

```typescript
interface FeeCalculator {
  polymarketFees(side: 'buy' | 'sell', price: number, quantity: number): number;
  kalshiFees(side: 'buy' | 'sell', price: number, quantity: number): number;
  totalRoundtripFees(opp: ArbitrageOpportunity): number;
}

// Fee estimation
function estimateFees(
  buyPlatform: Platform,
  sellPlatform: Platform,
  buyPrice: number,
  sellPrice: number
): number {
  let fees = 0;
  
  // Polymarket: ~1% maker rebate, ~2% taker fee (approximate)
  if (buyPlatform === 'polymarket') {
    fees += buyPrice * 0.02;  // Taker fee on buy
  }
  if (sellPlatform === 'polymarket') {
    fees += (1 - sellPrice) * 0.02;  // Fee on winnings if YES wins
  }
  
  // Kalshi: 7% on profits, max $0.07 per contract
  if (buyPlatform === 'kalshi') {
    // No fee on buy
  }
  if (sellPlatform === 'kalshi') {
    const potentialProfit = 1 - sellPrice;  // If YES wins
    fees += Math.min(potentialProfit * 0.07, 0.07);
  }
  
  return fees;
}
```

### 3.5 Execution Engine

```typescript
interface ExecutionEngine {
  // Execute an arbitrage opportunity
  execute(opp: ArbitrageOpportunity): Promise<ExecutionResult>;
  
  // Handle partial fills
  handlePartialFill(execution: Execution, filled: number): void;
  
  // Unwind position if one leg fails
  unwindPosition(execution: Execution): Promise<void>;
}

interface ExecutionResult {
  success: boolean;
  buyExecution: OrderExecution;
  sellExecution: OrderExecution;
  actualProfit: number;
  slippage: number;
  errors?: string[];
}

// Execution strategy
async function executeArbitrage(opp: ArbitrageOpportunity): Promise<ExecutionResult> {
  const quantity = calculateOptimalQuantity(opp);
  
  // Strategy: Execute both legs simultaneously to minimize timing risk
  const [buyResult, sellResult] = await Promise.allSettled([
    executeBuy(opp.buyPlatform, opp, quantity),
    executeSell(opp.sellPlatform, opp, quantity),
  ]);
  
  // Handle outcomes
  if (buyResult.status === 'fulfilled' && sellResult.status === 'fulfilled') {
    return {
      success: true,
      buyExecution: buyResult.value,
      sellExecution: sellResult.value,
      actualProfit: calculateActualProfit(buyResult.value, sellResult.value),
      slippage: calculateSlippage(opp, buyResult.value, sellResult.value),
    };
  }
  
  // One leg failed - need to unwind
  if (buyResult.status === 'fulfilled' && sellResult.status === 'rejected') {
    // We bought but couldn't sell - try to sell on same platform or hold
    await handleFailedSell(opp, buyResult.value);
  }
  
  if (buyResult.status === 'rejected' && sellResult.status === 'fulfilled') {
    // We sold but couldn't buy - critical error, need to cover
    await handleFailedBuy(opp, sellResult.value);
  }
  
  return {
    success: false,
    errors: [buyResult.reason, sellResult.reason].filter(Boolean),
    // ...
  };
}
```

### 3.6 Position & Risk Management

```typescript
interface PositionManager {
  // Track open positions across both platforms
  getPositions(): Position[];
  
  // Net exposure calculation
  getNetExposure(eventId: string): ExposureReport;
  
  // Track P&L
  getUnrealizedPnL(): number;
  getRealizedPnL(): number;
}

interface RiskManager {
  // Pre-trade checks
  canExecute(opp: ArbitrageOpportunity): RiskCheck;
  
  // Position limits
  checkPositionLimits(eventId: string, additionalQuantity: number): boolean;
  
  // Capital allocation
  getAvailableCapital(platform: Platform): number;
  
  // Exposure limits
  maxExposurePerEvent: number;
  maxTotalExposure: number;
  maxPositionImbalance: number;  // Allowed net position per event
}

interface RiskCheck {
  approved: boolean;
  reasons?: string[];
  warnings?: string[];
  suggestedQuantity?: number;  // Reduced quantity if limits hit
}

// Risk parameters
const RISK_PARAMS = {
  maxExposurePerEvent: 10000,    // $10k max per event
  maxTotalExposure: 100000,      // $100k total
  maxPositionImbalance: 1000,    // Max net exposure if hedges don't match
  minProfitThreshold: 0.02,      // 2% minimum spread after fees
  maxSlippageTolerance: 0.01,    // 1% max slippage
  minLiquidityDepth: 500,        // Minimum shares available
};
```

---

## 4. Data Models

### 4.1 Database Schema

```sql
-- Event mappings
CREATE TABLE event_mappings (
  id UUID PRIMARY KEY,
  polymarket_condition_id VARCHAR(66) NOT NULL,
  kalshi_ticker VARCHAR(50) NOT NULL,
  description TEXT,
  match_confidence DECIMAL(3,2),
  match_method VARCHAR(20),
  resolution_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE,
  UNIQUE(polymarket_condition_id, kalshi_ticker)
);

-- Arbitrage opportunities detected
CREATE TABLE opportunities (
  id UUID PRIMARY KEY,
  event_mapping_id UUID REFERENCES event_mappings(id),
  detected_at TIMESTAMP DEFAULT NOW(),
  buy_platform VARCHAR(20),
  buy_price DECIMAL(10,6),
  buy_quantity DECIMAL(18,6),
  sell_platform VARCHAR(20),
  sell_price DECIMAL(10,6),
  sell_quantity DECIMAL(18,6),
  gross_spread DECIMAL(10,6),
  estimated_fees DECIMAL(10,6),
  net_profit DECIMAL(10,6),
  was_executed BOOLEAN DEFAULT FALSE,
  expired_at TIMESTAMP
);

-- Executions
CREATE TABLE executions (
  id UUID PRIMARY KEY,
  opportunity_id UUID REFERENCES opportunities(id),
  executed_at TIMESTAMP DEFAULT NOW(),
  status VARCHAR(20),  -- 'pending', 'partial', 'complete', 'failed'
  
  -- Buy leg
  buy_order_id VARCHAR(100),
  buy_fill_price DECIMAL(10,6),
  buy_fill_quantity DECIMAL(18,6),
  buy_fees DECIMAL(10,6),
  
  -- Sell leg
  sell_order_id VARCHAR(100),
  sell_fill_price DECIMAL(10,6),
  sell_fill_quantity DECIMAL(18,6),
  sell_fees DECIMAL(10,6),
  
  -- Results
  actual_profit DECIMAL(10,6),
  slippage DECIMAL(10,6),
  notes TEXT
);

-- Positions
CREATE TABLE positions (
  id UUID PRIMARY KEY,
  platform VARCHAR(20),
  event_id VARCHAR(100),  -- platform-specific event ID
  event_mapping_id UUID REFERENCES event_mappings(id),
  side VARCHAR(10),  -- 'yes' or 'no'
  quantity DECIMAL(18,6),
  avg_price DECIMAL(10,6),
  current_price DECIMAL(10,6),
  unrealized_pnl DECIMAL(10,6),
  opened_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- P&L tracking
CREATE TABLE pnl_records (
  id UUID PRIMARY KEY,
  date DATE,
  platform VARCHAR(20),
  realized_pnl DECIMAL(12,6),
  unrealized_pnl DECIMAL(12,6),
  fees_paid DECIMAL(12,6),
  volume_traded DECIMAL(18,6),
  num_trades INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 5. API Specifications

### 5.1 Polymarket API

```typescript
// Base URL: https://clob.polymarket.com

// Get all markets
GET /markets
Response: {
  markets: PolymarketMarket[]
}

// Get orderbook
GET /book?token_id={tokenId}
Response: {
  bids: { price: string, size: string }[],
  asks: { price: string, size: string }[],
  timestamp: string
}

// WebSocket: wss://ws-subscriptions-clob.polymarket.com/ws/market
// Subscribe message:
{
  "type": "subscribe",
  "channel": "book",
  "assets_ids": ["token_id_1", "token_id_2"]
}

// Place order (requires CLOB API key + wallet signature)
POST /order
Body: {
  tokenId: string,
  side: 'buy' | 'sell',
  price: string,
  size: string,
  orderType: 'GTC' | 'FOK' | 'GTD',
  signature: string,
  // ... other fields
}
```

### 5.2 Kalshi API

```typescript
// Base URL: https://trading-api.kalshi.com/trade-api/v2

// Authentication
POST /login
Body: { email: string, password: string }
Response: { token: string, member_id: string }

// Get markets
GET /markets?status=open&cursor={cursor}
Response: {
  markets: KalshiMarket[],
  cursor: string
}

// Get orderbook
GET /markets/{ticker}/orderbook
Response: {
  yes: { price: number, quantity: number }[],
  no: { price: number, quantity: number }[],
  timestamp: string
}

// WebSocket: wss://trading-api.kalshi.com/trade-api/ws/v2
// Requires authentication token

// Place order
POST /portfolio/orders
Body: {
  ticker: string,
  action: 'buy' | 'sell',
  side: 'yes' | 'no',
  type: 'limit' | 'market',
  count: number,
  yes_price?: number,  // in cents
  no_price?: number,
  expiration_ts?: number
}
```

---

## 6. Configuration

```yaml
# config.yaml

# Platform credentials
polymarket:
  api_key: ${POLYMARKET_API_KEY}
  private_key: ${POLYMARKET_PRIVATE_KEY}  # For signing
  rpc_url: "https://polygon-rpc.com"
  
kalshi:
  email: ${KALSHI_EMAIL}
  password: ${KALSHI_PASSWORD}
  api_base: "https://trading-api.kalshi.com/trade-api/v2"

# Trading parameters
trading:
  min_profit_threshold: 0.02      # 2% minimum profit after fees
  max_position_per_event: 10000   # $10k max per event
  max_total_exposure: 100000      # $100k total exposure
  min_liquidity: 500              # Minimum depth required
  max_slippage: 0.01              # 1% max slippage
  execution_timeout_ms: 5000      # Order timeout

# Risk management
risk:
  max_imbalance: 1000             # Max unhedged exposure
  stop_loss_pct: 0.10             # 10% stop loss per event
  daily_loss_limit: 5000          # Stop trading after $5k daily loss
  
# Monitoring
monitoring:
  alert_on_execution_failure: true
  alert_on_large_opportunity: 5000  # Alert if >$5k opportunity
  metrics_port: 9090
  
# Database
database:
  host: localhost
  port: 5432
  name: arb_bot
  user: ${DB_USER}
  password: ${DB_PASSWORD}
```

---

## 7. Operational Considerations

### 7.1 Capital Management

```
┌─────────────────────────────────────────────────────────────┐
│                    CAPITAL ALLOCATION                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Total Capital: $100,000                                    │
│                                                             │
│  ┌──────────────────┐    ┌──────────────────┐              │
│  │   Polymarket     │    │     Kalshi       │              │
│  │   $50,000 USDC   │    │   $50,000 USD    │              │
│  │   (on Polygon)   │    │   (in account)   │              │
│  └──────────────────┘    └──────────────────┘              │
│                                                             │
│  Reserve: $10,000 (for rebalancing/gas)                    │
│                                                             │
│  Rebalance triggers:                                        │
│  - Platform balance < 30% of total                         │
│  - Weekly scheduled rebalance                               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 Rebalancing

Capital will naturally accumulate on one platform. Rebalancing process:

1. **Polymarket → Kalshi:**
   - Withdraw USDC to Ethereum
   - Bridge to mainnet or offramp via Coinbase/etc
   - Deposit USD to Kalshi

2. **Kalshi → Polymarket:**
   - Withdraw USD from Kalshi (T+1)
   - Buy USDC
   - Bridge to Polygon
   - Deposit to Polymarket wallet

**Estimated rebalancing costs:** ~1-2% (bridge fees, spread, gas)

### 7.3 Settlement Risk

- **Timing mismatch:** Polymarket settles immediately on-chain; Kalshi settles T+1
- **Resolution disputes:** Rare but possible
- **Mitigation:** Only trade events with clear, objective resolution criteria

### 7.4 Regulatory Considerations

- Kalshi is CFTC-regulated; users must be US residents
- Polymarket technically not available to US users
- Consider legal/compliance review before operating

---

## 8. Monitoring & Alerts

### 8.1 Metrics to Track

```typescript
// Prometheus metrics
const metrics = {
  // Performance
  opportunities_detected: Counter,
  opportunities_executed: Counter,
  execution_success_rate: Gauge,
  
  // Latency
  opportunity_detection_latency_ms: Histogram,
  execution_latency_ms: Histogram,
  
  // Financial
  realized_pnl_usd: Gauge,
  unrealized_pnl_usd: Gauge,
  total_volume_usd: Counter,
  
  // Risk
  current_exposure: Gauge,
  position_imbalance: Gauge,
  
  // Health
  polymarket_ws_connected: Gauge,
  kalshi_ws_connected: Gauge,
  last_opportunity_time: Gauge,
};
```

### 8.2 Alerts

| Alert | Condition | Severity |
|-------|-----------|----------|
| Execution Failure | Any leg fails | High |
| Large Position Imbalance | > $5k unhedged | High |
| Connection Lost | WS disconnected > 1 min | High |
| Daily Loss Limit | > $5k daily loss | Critical |
| Large Opportunity Missed | > 5% spread not executed | Medium |
| Low Balance | < $10k on either platform | Medium |

---

## 9. Testing Strategy

### 9.1 Unit Tests
- Fee calculation accuracy
- Opportunity detection logic
- Event matching algorithms

### 9.2 Integration Tests
- API connectivity
- Order placement (using test/paper accounts)
- WebSocket reliability

### 9.3 Paper Trading
- Run full system with real market data
- Log hypothetical trades
- Measure expected vs actual prices

### 9.4 Gradual Rollout
1. Start with $1k capital
2. Limit to 3 event pairs initially
3. Scale up over 2-4 weeks based on results

---

## 10. Implementation Roadmap

### Phase 1: Foundation (Week 1-2)
- [ ] Set up project structure
- [ ] Implement Polymarket connector
- [ ] Implement Kalshi connector
- [ ] Basic event matching (manual curation)
- [ ] Database setup

### Phase 2: Detection (Week 3-4)
- [ ] Real-time orderbook aggregation
- [ ] Arbitrage opportunity detection
- [ ] Fee calculation
- [ ] Logging and metrics

### Phase 3: Execution (Week 5-6)
- [ ] Order placement logic
- [ ] Position tracking
- [ ] Risk management checks
- [ ] Error handling and recovery

### Phase 4: Operations (Week 7-8)
- [ ] Monitoring dashboard
- [ ] Alerting system
- [ ] Paper trading validation
- [ ] Production deployment

### Phase 5: Optimization (Ongoing)
- [ ] Improve event matching (ML/LLM)
- [ ] Reduce latency
- [ ] Advanced execution strategies
- [ ] Auto-rebalancing

---

## Appendix A: Example Arbitrage Calculation

**Scenario:**
- Event: "Will BTC be above $100k on Dec 31, 2025?"
- Polymarket YES price: $0.45 (ask)
- Kalshi YES price: $0.52 (bid)

**Trade:**
- Buy 1000 YES on Polymarket @ $0.45 = $450 cost
- Sell 1000 YES on Kalshi @ $0.52 = $520 received

**Gross profit:** $70 (15.6% return on capital)

**Fees:**
- Polymarket taker fee: ~$9 (2% of $450)
- Kalshi fee if win: ~$3.36 (7% of profit, capped)

**Net profit:** ~$57.64 (12.8% return)

**Risk:** If orders don't fill simultaneously, exposed to price movement.

---

## Appendix B: Known Event Pairs (Starter List)

| Polymarket | Kalshi | Category |
|------------|--------|----------|
| "Will X win 2024 election" | "PRES-24" | Politics |
| "Will Fed raise rates in Q1" | "FED-RATE-Q1" | Economics |
| "BTC above $X by date" | "BTC-X-DATE" | Crypto |
| "Will company X IPO" | "IPO-X" | Markets |

---

## Appendix C: Tech Stack Recommendations

- **Language:** TypeScript/Node.js (good async support, both APIs have JS SDKs)
- **Database:** PostgreSQL (relational, good for financial data)
- **Cache:** Redis (orderbook caching, rate limiting)
- **Queue:** Bull/BullMQ (job queue for executions)
- **Monitoring:** Prometheus + Grafana
- **Alerting:** PagerDuty or Telegram bot
- **Deployment:** Docker + Kubernetes or simple VPS

---

*Last updated: January 2025*
*Version: 1.0.0*
