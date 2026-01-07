import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PolymarketMarket, KalshiMarket } from '../../src/types/index.js';

// Mock dependencies
vi.mock('../../src/config/index.js', () => ({
  getConfig: () => ({
    matching: {
      minConfidenceThreshold: 0.95,
      exactMatchConfidence: 1.0,
      fuzzyMatchMinSimilarity: 0.95,
      requireDateValidation: true,
      requireCategoryMatch: true,
    },
  }),
}));

vi.mock('../../src/db/index.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock('../../src/utils/logger.js', () => ({
  createChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { EventMatcher } from '../../src/core/event-matcher.js';

describe('EventMatcher', () => {
  let eventMatcher: EventMatcher;

  const createPolyMarket = (overrides?: Partial<PolymarketMarket>): PolymarketMarket => ({
    id: 'poly-1',
    conditionId: 'condition-123',
    questionId: 'question-456',
    title: 'Will Bitcoin reach $100k by end of 2025?',
    description: 'Test market',
    outcomes: ['Yes', 'No'],
    outcomePrices: [0.55, 0.45],
    tokens: { yes: 'token-yes', no: 'token-no' },
    endDate: new Date('2025-12-31'),
    volume: 100000,
    liquidity: 50000,
    ...overrides,
  });

  const createKalshiMarket = (overrides?: Partial<KalshiMarket>): KalshiMarket => ({
    id: 'kalshi-1',
    ticker: 'BTC-100K-2025',
    title: 'Will Bitcoin reach $100k by end of 2025?',
    category: 'crypto',
    yesPrice: 0.55,
    noPrice: 0.45,
    volume: 80000,
    openInterest: 10000,
    endDate: new Date('2025-12-31'),
    expirationTime: new Date('2025-12-31'),
    settlementTime: new Date('2026-01-01'),
    ...overrides,
  });

  beforeEach(() => {
    eventMatcher = new EventMatcher();
  });

  describe('findKalshiEquivalent', () => {
    it('should find exact match', async () => {
      const polyMarket = createPolyMarket();
      const kalshiMarkets = [createKalshiMarket()];

      const mapping = await eventMatcher.findKalshiEquivalent(polyMarket, kalshiMarkets);

      expect(mapping).not.toBeNull();
      expect(mapping?.matchMethod).toBe('exact');
      expect(mapping?.matchConfidence).toBe(1.0);
      expect(mapping?.polymarketConditionId).toBe(polyMarket.conditionId);
      expect(mapping?.kalshiTicker).toBe(kalshiMarkets[0].ticker);
    });

    it('should find fuzzy match with high similarity', async () => {
      // Titles differ by just one character ('s' in Bitcoins) for >0.95 similarity
      const polyMarket = createPolyMarket({
        title: 'Will Bitcoins reach 100k by end of 2025?',
      });
      const kalshiMarkets = [createKalshiMarket({
        title: 'Will Bitcoin reach 100k by end of 2025?',
      })];

      const mapping = await eventMatcher.findKalshiEquivalent(polyMarket, kalshiMarkets);

      expect(mapping).not.toBeNull();
      expect(mapping?.matchMethod).toBe('fuzzy');
      expect(mapping?.matchConfidence).toBeGreaterThanOrEqual(0.95);
    });

    it('should reject fuzzy match with low similarity', async () => {
      const polyMarket = createPolyMarket({
        title: 'Will Bitcoin reach $100k?',
      });
      const kalshiMarkets = [createKalshiMarket({
        title: 'Will Ethereum reach $10k?',
      })];

      const mapping = await eventMatcher.findKalshiEquivalent(polyMarket, kalshiMarkets);

      expect(mapping).toBeNull();
    });

    it('should reject fuzzy match when dates do not align', async () => {
      // Titles differ by just one character ('s' in Bitcoins) for >0.95 similarity
      const polyMarket = createPolyMarket({
        title: 'Will Bitcoins reach 100k by end of 2025?',
        endDate: new Date('2025-12-31'),
      });
      const kalshiMarkets = [createKalshiMarket({
        title: 'Will Bitcoin reach 100k by end of 2025?',
        expirationTime: new Date('2026-06-30'), // Different date - outside 24h tolerance
      })];

      const mapping = await eventMatcher.findKalshiEquivalent(polyMarket, kalshiMarkets);

      expect(mapping).toBeNull();
    });

    it('should reject exact match when dates do not align', async () => {
      // Exact same title but different dates - should be rejected
      const polyMarket = createPolyMarket({
        title: 'Will Bitcoin reach $100k by end of 2025?',
        endDate: new Date('2025-12-31'),
      });
      const kalshiMarkets = [createKalshiMarket({
        title: 'Will Bitcoin reach $100k by end of 2025?',
        expirationTime: new Date('2026-06-30'), // Different date - outside 24h tolerance
      })];

      const mapping = await eventMatcher.findKalshiEquivalent(polyMarket, kalshiMarkets);

      // Should be null because dates don't align (exact matches now also require date validation)
      expect(mapping).toBeNull();
    });

    it('should select best match when multiple candidates exist', async () => {
      const polyMarket = createPolyMarket({
        title: 'Will Bitcoin reach 100k by end of 2025?',
      });

      // Multiple Kalshi markets - one fuzzy match (0.97), one exact match (1.0)
      const kalshiMarkets = [
        createKalshiMarket({
          ticker: 'BTC-FUZZY',
          title: 'Will Bitcoins reach 100k by end of 2025?', // Fuzzy match (~0.97)
        }),
        createKalshiMarket({
          ticker: 'BTC-EXACT',
          title: 'Will Bitcoin reach 100k by end of 2025?', // Exact match (1.0)
        }),
      ];

      const mapping = await eventMatcher.findKalshiEquivalent(polyMarket, kalshiMarkets);

      // Should select the exact match (higher confidence) even though fuzzy came first
      expect(mapping).not.toBeNull();
      expect(mapping?.kalshiTicker).toBe('BTC-EXACT');
      expect(mapping?.matchMethod).toBe('exact');
      expect(mapping?.matchConfidence).toBe(1.0);
    });

    it('should select highest confidence fuzzy match among multiple candidates', async () => {
      const polyMarket = createPolyMarket({
        title: 'Will Bitcoin reach 100k by end of 2025?',
      });

      // Multiple fuzzy matches with different similarities
      const kalshiMarkets = [
        createKalshiMarket({
          ticker: 'BTC-LOW',
          title: 'Will Bitcoins reach 100k by end of 2025?', // Lower similarity (~0.97)
        }),
        createKalshiMarket({
          ticker: 'BTC-HIGH',
          title: 'Will Bitcoin reach 100k by end of 2025', // Higher similarity (~0.98, missing ?)
        }),
      ];

      const mapping = await eventMatcher.findKalshiEquivalent(polyMarket, kalshiMarkets);

      // Should select the higher confidence match
      expect(mapping).not.toBeNull();
      expect(mapping?.kalshiTicker).toBe('BTC-HIGH');
    });

    it('should return null when no markets match', async () => {
      const polyMarket = createPolyMarket();
      const kalshiMarkets: KalshiMarket[] = [];

      const mapping = await eventMatcher.findKalshiEquivalent(polyMarket, kalshiMarkets);

      expect(mapping).toBeNull();
    });
  });

  describe('canTradeOnMapping', () => {
    it('should allow trading on high confidence mapping', () => {
      const mapping = {
        id: 'test-1',
        polymarketConditionId: 'poly-1',
        kalshiTicker: 'KALSHI-1',
        eventDescription: 'Test',
        matchConfidence: 0.98,
        resolutionDate: new Date(),
        matchMethod: 'fuzzy' as const,
        outcomeMapping: [],
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(eventMatcher.canTradeOnMapping(mapping)).toBe(true);
    });

    it('should reject trading on low confidence mapping', () => {
      const mapping = {
        id: 'test-1',
        polymarketConditionId: 'poly-1',
        kalshiTicker: 'KALSHI-1',
        eventDescription: 'Test',
        matchConfidence: 0.90, // Below 0.95 threshold
        resolutionDate: new Date(),
        matchMethod: 'fuzzy' as const,
        outcomeMapping: [],
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(eventMatcher.canTradeOnMapping(mapping)).toBe(false);
    });

    it('should allow trading on manual mappings', () => {
      const mapping = {
        id: 'test-1',
        polymarketConditionId: 'poly-1',
        kalshiTicker: 'KALSHI-1',
        eventDescription: 'Test',
        matchConfidence: 1.0,
        resolutionDate: new Date(),
        matchMethod: 'manual' as const,
        outcomeMapping: [],
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(eventMatcher.canTradeOnMapping(mapping)).toBe(true);
    });
  });

  describe('addManualMapping', () => {
    it('should create manual mapping with 1.0 confidence', async () => {
      const mapping = await eventMatcher.addManualMapping(
        'poly-condition-123',
        'KALSHI-TICKER',
        'Test Event Description'
      );

      expect(mapping.matchConfidence).toBe(1.0);
      expect(mapping.matchMethod).toBe('manual');
      expect(mapping.polymarketConditionId).toBe('poly-condition-123');
      expect(mapping.kalshiTicker).toBe('KALSHI-TICKER');
    });
  });

  describe('getActiveMappings', () => {
    it('should return empty array initially', () => {
      const mappings = eventMatcher.getActiveMappings();
      expect(mappings).toEqual([]);
    });
  });
});
