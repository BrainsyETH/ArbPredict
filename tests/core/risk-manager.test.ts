import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ArbitrageOpportunity, EventMapping } from '../../src/types/index.js';

// Mock dependencies
vi.mock('../../src/config/index.js', () => ({
  getConfig: () => ({
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
    smallPosition: {
      minTradeValueUsd: 5,
      minProfitUsd: 0.10,
      estimatedGasCostUsd: 0.01,
      maxGasAsPercentOfTrade: 0.02,
    },
  }),
}));

vi.mock('../../src/core/state.js', () => ({
  getStateManager: () => ({
    getDailyPnL: () => 0,
    getState: () => ({
      dailyPnL: 0,
      openPositions: [],
    }),
  }),
}));

vi.mock('../../src/core/circuit-breaker.js', () => ({
  getCircuitBreaker: () => ({
    isPaused: () => false,
    getPauseReason: () => null,
  }),
}));

vi.mock('../../src/utils/logger.js', () => ({
  createChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { RiskManager } from '../../src/core/risk-manager.js';

describe('RiskManager', () => {
  let riskManager: RiskManager;

  const createMockMapping = (): EventMapping => ({
    id: 'test-mapping-1',
    polymarketConditionId: 'poly-123',
    kalshiTicker: 'KALSHI-TEST',
    eventDescription: 'Test Event',
    matchConfidence: 1.0,
    resolutionDate: new Date('2025-12-31'),
    matchMethod: 'exact',
    outcomeMapping: [],
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const createMockOpportunity = (overrides?: Partial<ArbitrageOpportunity>): ArbitrageOpportunity => ({
    id: 'opp-1',
    timestamp: new Date(),
    eventMapping: createMockMapping(),
    buyPlatform: 'polymarket',
    buyPrice: 0.50,
    buyQuantity: 100,
    sellPlatform: 'kalshi',
    sellPrice: 0.55,
    sellQuantity: 100,
    grossSpread: 0.05,
    estimatedFees: 0.01,
    netProfit: 0.04,
    maxQuantity: 100,
    executionRisk: 0.1,
    expirationTime: new Date(Date.now() + 5000),
    ...overrides,
  });

  beforeEach(() => {
    riskManager = new RiskManager();
  });

  describe('validateTrade', () => {
    it('should approve valid trade', () => {
      const opportunity = createMockOpportunity();
      const result = riskManager.validateTrade(opportunity, 10);

      expect(result.approved).toBe(true);
      expect(result.reasons).toBeUndefined();
    });

    it('should reject trade exceeding max quantity', () => {
      const opportunity = createMockOpportunity();
      const result = riskManager.validateTrade(opportunity, 100); // Exceeds max of 50

      expect(result.approved).toBe(false);
      expect(result.reasons).toBeDefined();
      expect(result.reasons?.some(r => r.includes('Quantity'))).toBe(true);
    });

    it('should reject trade below minimum quantity', () => {
      const opportunity = createMockOpportunity();
      const result = riskManager.validateTrade(opportunity, 0);

      expect(result.approved).toBe(false);
      expect(result.reasons).toBeDefined();
    });

    it('should reject trade below minimum trade value', () => {
      const opportunity = createMockOpportunity({ buyPrice: 0.01 });
      const result = riskManager.validateTrade(opportunity, 1); // $0.01 trade value

      expect(result.approved).toBe(false);
      expect(result.reasons?.some(r => r.includes('Trade value'))).toBe(true);
    });

    it('should reject trade below minimum profit threshold', () => {
      const opportunity = createMockOpportunity({
        netProfit: 0.001, // Very low profit
        buyPrice: 0.50,
      });
      const result = riskManager.validateTrade(opportunity, 10);

      expect(result.approved).toBe(false);
      expect(result.reasons?.some(r => r.includes('profit'))).toBe(true);
    });

    it('should suggest reduced quantity when exposure limit would be exceeded', () => {
      const opportunity = createMockOpportunity({ buyPrice: 0.50 });
      const result = riskManager.validateTrade(opportunity, 50);

      // With $0.50 price and 50 qty = $25. Max is $100.
      // So suggested should be capped at max quantity per trade (50)
      expect(result.suggestedQuantity).toBeLessThanOrEqual(50);
    });

    it('should add warning for low liquidity', () => {
      const opportunity = createMockOpportunity({ maxQuantity: 30 }); // Below 50 threshold
      const result = riskManager.validateTrade(opportunity, 10);

      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some(w => w.includes('liquidity'))).toBe(true);
    });

    it('should add warning for high execution risk', () => {
      const opportunity = createMockOpportunity({ executionRisk: 0.6 });
      const result = riskManager.validateTrade(opportunity, 10);

      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some(w => w.includes('execution risk'))).toBe(true);
    });
  });

  describe('calculateOptimalQuantity', () => {
    it('should return minimum of available quantities', () => {
      const opportunity = createMockOpportunity({
        buyQuantity: 30,
        sellQuantity: 40,
        maxQuantity: 35,
      });

      const quantity = riskManager.calculateOptimalQuantity(opportunity);
      expect(quantity).toBeLessThanOrEqual(30);
    });

    it('should cap at max quantity per trade', () => {
      const opportunity = createMockOpportunity({
        buyQuantity: 100,
        sellQuantity: 100,
        maxQuantity: 100,
      });

      const quantity = riskManager.calculateOptimalQuantity(opportunity);
      expect(quantity).toBeLessThanOrEqual(50); // Max per trade
    });
  });

  describe('position tracking', () => {
    it('should track added positions', () => {
      riskManager.addPosition({
        id: 'pos-1',
        platform: 'polymarket',
        eventId: 'event-1',
        side: 'yes',
        quantity: 10,
        avgPrice: 0.50,
        currentPrice: 0.50,
        unrealizedPnL: 0,
        openedAt: new Date(),
        updatedAt: new Date(),
      });

      const exposure = riskManager.getEventExposure('event-1');
      expect(exposure).toBe(5); // 10 * 0.50
    });

    it('should calculate total exposure', () => {
      riskManager.addPosition({
        id: 'pos-1',
        platform: 'polymarket',
        eventId: 'event-1',
        side: 'yes',
        quantity: 10,
        avgPrice: 0.50,
        currentPrice: 0.50,
        unrealizedPnL: 0,
        openedAt: new Date(),
        updatedAt: new Date(),
      });

      riskManager.addPosition({
        id: 'pos-2',
        platform: 'kalshi',
        eventId: 'event-2',
        side: 'yes',
        quantity: 20,
        avgPrice: 0.40,
        currentPrice: 0.40,
        unrealizedPnL: 0,
        openedAt: new Date(),
        updatedAt: new Date(),
      });

      const totalExposure = riskManager.getTotalExposure();
      expect(totalExposure).toBe(13); // (10*0.50) + (20*0.40)
    });
  });

  describe('inventory management', () => {
    it('should calculate net inventory correctly', () => {
      riskManager.addPosition({
        id: 'pos-1',
        platform: 'polymarket',
        eventId: 'event-1',
        side: 'yes',
        quantity: 10,
        avgPrice: 0.50,
        currentPrice: 0.50,
        unrealizedPnL: 0,
        openedAt: new Date(),
        updatedAt: new Date(),
      });

      riskManager.addPosition({
        id: 'pos-2',
        platform: 'kalshi',
        eventId: 'event-1',
        side: 'no',
        quantity: 5,
        avgPrice: 0.50,
        currentPrice: 0.50,
        unrealizedPnL: 0,
        openedAt: new Date(),
        updatedAt: new Date(),
      });

      const inventory = riskManager.getNetInventory('event-1');
      expect(inventory.polymarketYesQty).toBe(10);
      expect(inventory.kalshiNoQty).toBe(5);
      expect(inventory.netPosition).toBe(5); // 10 yes - 5 no
    });

    it('should flag rebalancing when imbalance exceeds threshold', () => {
      riskManager.addPosition({
        id: 'pos-1',
        platform: 'polymarket',
        eventId: 'event-1',
        side: 'yes',
        quantity: 50,
        avgPrice: 0.50,
        currentPrice: 0.50,
        unrealizedPnL: 0,
        openedAt: new Date(),
        updatedAt: new Date(),
      });

      const inventory = riskManager.getNetInventory('event-1');
      expect(inventory.needsRebalancing).toBe(true); // $25 imbalance > $10 threshold
    });
  });
});
