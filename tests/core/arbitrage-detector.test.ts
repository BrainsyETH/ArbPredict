import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OrderBook, EventMapping } from '../../src/types/index.js';

// Mock the config
vi.mock('../../src/config/index.js', () => ({
  getConfig: () => ({
    trading: {
      minProfitThreshold: 0.03,
    },
    risk: {
      minLiquidityDepth: 50,
    },
    smallPosition: {
      estimatedGasCostUsd: 0.01,
    },
    latency: {
      orderbookFetchTargetMs: 100,
    },
    retry: {
      api: {
        maxRetries: 3,
        retryDelayMs: 1000,
        backoffMultiplier: 2,
        maxRetryDelayMs: 8000,
        retryableErrors: [],
      },
    },
  }),
}));

// Mock connectors
vi.mock('../../src/connectors/polymarket/index.js', () => ({
  getPolymarketConnector: () => ({
    getOrderBook: vi.fn(),
  }),
}));

vi.mock('../../src/connectors/kalshi/index.js', () => ({
  getKalshiConnector: () => ({
    getOrderBook: vi.fn(),
  }),
}));

vi.mock('../../src/core/event-matcher.js', () => ({
  getEventMatcher: () => ({
    getActiveMappings: () => [],
    canTradeOnMapping: () => true,
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

import { ArbitrageDetector, calculateProfitDetails } from '../../src/core/arbitrage-detector.js';

describe('ArbitrageDetector', () => {
  let detector: ArbitrageDetector;

  beforeEach(() => {
    detector = new ArbitrageDetector();
  });

  describe('detectArbitrage', () => {
    const createMockMapping = (): EventMapping => ({
      id: 'test-mapping-1',
      polymarketConditionId: 'poly-123',
      kalshiTicker: 'KALSHI-TEST',
      eventDescription: 'Test Event',
      matchConfidence: 1.0,
      resolutionDate: new Date('2025-12-31'),
      matchMethod: 'exact',
      outcomeMapping: [
        { polymarketOutcome: 'Yes', kalshiSide: 'yes' },
        { polymarketOutcome: 'No', kalshiSide: 'no' },
      ],
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    it('should detect opportunity when Polymarket is cheaper', () => {
      const polyBook: OrderBook = {
        bids: [{ price: 0.40, size: 100 }],
        asks: [{ price: 0.42, size: 100 }],
        timestamp: new Date(),
      };

      const kalshiBook: OrderBook = {
        bids: [{ price: 0.50, size: 100 }], // Higher bid = we can sell here
        asks: [{ price: 0.52, size: 100 }],
        timestamp: new Date(),
      };

      const mapping = createMockMapping();
      const opportunity = detector.detectArbitrage(polyBook, kalshiBook, mapping);

      expect(opportunity).not.toBeNull();
      expect(opportunity?.buyPlatform).toBe('polymarket');
      expect(opportunity?.sellPlatform).toBe('kalshi');
      expect(opportunity?.buyPrice).toBe(0.42);
      expect(opportunity?.sellPrice).toBe(0.50);
      expect(opportunity?.grossSpread).toBe(0.08);
    });

    it('should detect opportunity when Kalshi is cheaper', () => {
      const polyBook: OrderBook = {
        bids: [{ price: 0.55, size: 100 }], // Higher bid = we can sell here
        asks: [{ price: 0.57, size: 100 }],
        timestamp: new Date(),
      };

      const kalshiBook: OrderBook = {
        bids: [{ price: 0.42, size: 100 }],
        asks: [{ price: 0.45, size: 100 }], // Lower ask = we can buy here
        timestamp: new Date(),
      };

      const mapping = createMockMapping();
      const opportunity = detector.detectArbitrage(polyBook, kalshiBook, mapping);

      expect(opportunity).not.toBeNull();
      expect(opportunity?.buyPlatform).toBe('kalshi');
      expect(opportunity?.sellPlatform).toBe('polymarket');
      expect(opportunity?.buyPrice).toBe(0.45);
      expect(opportunity?.sellPrice).toBe(0.55);
    });

    it('should return null when no profitable spread exists', () => {
      const polyBook: OrderBook = {
        bids: [{ price: 0.48, size: 100 }],
        asks: [{ price: 0.50, size: 100 }],
        timestamp: new Date(),
      };

      const kalshiBook: OrderBook = {
        bids: [{ price: 0.49, size: 100 }],
        asks: [{ price: 0.51, size: 100 }],
        timestamp: new Date(),
      };

      const mapping = createMockMapping();
      const opportunity = detector.detectArbitrage(polyBook, kalshiBook, mapping);

      expect(opportunity).toBeNull();
    });

    it('should return null when liquidity is insufficient', () => {
      const polyBook: OrderBook = {
        bids: [{ price: 0.40, size: 10 }], // Low liquidity
        asks: [{ price: 0.42, size: 10 }],
        timestamp: new Date(),
      };

      const kalshiBook: OrderBook = {
        bids: [{ price: 0.55, size: 10 }],
        asks: [{ price: 0.57, size: 10 }],
        timestamp: new Date(),
      };

      const mapping = createMockMapping();
      const opportunity = detector.detectArbitrage(polyBook, kalshiBook, mapping);

      // Should be null due to low liquidity (< 50)
      expect(opportunity).toBeNull();
    });
  });
});

describe('calculateProfitDetails', () => {
  it('should calculate correct profit for polymarket buy, kalshi sell', () => {
    const result = calculateProfitDetails('polymarket', 'kalshi', 0.45, 0.55, 10);

    expect(result.grossProfit).toBe(1.0); // (0.55 - 0.45) * 10
    expect(result.polymarketFees).toBeGreaterThan(0);
    expect(result.kalshiFees).toBeGreaterThan(0);
    expect(result.netProfit).toBeLessThan(result.grossProfit);
  });

  it('should calculate correct profit for kalshi buy, polymarket sell', () => {
    const result = calculateProfitDetails('kalshi', 'polymarket', 0.45, 0.55, 10);

    expect(result.grossProfit).toBe(1.0);
    expect(result.netProfit).toBeLessThan(result.grossProfit);
  });

  it('should include gas cost for polymarket trades', () => {
    const result = calculateProfitDetails('polymarket', 'kalshi', 0.45, 0.55, 10);
    expect(result.gasCost).toBeGreaterThan(0);
  });

  it('should calculate profit percentage correctly', () => {
    const result = calculateProfitDetails('polymarket', 'kalshi', 0.50, 0.60, 10);

    // Gross would be 1.0, on 5.0 investment = 20% gross
    expect(result.profitPercentage).toBeLessThan(0.20); // Less due to fees
    expect(result.profitPercentage).toBeGreaterThan(0);
  });
});
