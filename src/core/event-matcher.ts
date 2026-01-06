import type {
  EventMapping,
  PolymarketMarket,
  KalshiMarket,
  MatchMethod,
  OutcomeMapping,
} from '../types/index.js';
import { getConfig } from '../config/index.js';
import { query } from '../db/index.js';
import { createChildLogger } from '../utils/logger.js';
import {
  normalize,
  levenshteinSimilarity,
  datesMatch,
  generateId,
} from '../utils/helpers.js';

const logger = createChildLogger('event-matcher');

// Category mappings between platforms
const CATEGORY_MAPPINGS: Record<string, string[]> = {
  politics: ['politics', 'elections', 'government', 'political'],
  economics: ['economics', 'fed', 'economy', 'financial', 'finance'],
  crypto: ['crypto', 'cryptocurrency', 'bitcoin', 'btc', 'ethereum', 'eth'],
  sports: ['sports', 'nfl', 'nba', 'mlb', 'soccer', 'football'],
  entertainment: ['entertainment', 'media', 'movies', 'oscars', 'awards'],
  science: ['science', 'tech', 'technology', 'space', 'climate'],
};

/**
 * Event matching service
 * Maps equivalent events between Polymarket and Kalshi
 */
export class EventMatcher {
  private manualMappings: Map<string, string> = new Map();
  private cachedMappings: Map<string, EventMapping> = new Map();

  /**
   * Load manual mappings from database
   */
  async loadMappings(): Promise<void> {
    try {
      const result = await query<{
        polymarket_condition_id: string;
        kalshi_ticker: string;
        id: string;
        description: string;
        match_confidence: string;
        match_method: string;
        resolution_date: Date;
        is_active: boolean;
        created_at: Date;
        updated_at: Date;
      }>(
        'SELECT * FROM event_mappings WHERE is_active = true'
      );

      for (const row of result.rows) {
        const mapping: EventMapping = {
          id: row.id,
          polymarketConditionId: row.polymarket_condition_id,
          kalshiTicker: row.kalshi_ticker,
          eventDescription: row.description,
          matchConfidence: parseFloat(row.match_confidence),
          resolutionDate: row.resolution_date,
          matchMethod: row.match_method as MatchMethod,
          outcomeMapping: [],
          isActive: row.is_active,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };

        this.cachedMappings.set(row.polymarket_condition_id, mapping);
        this.manualMappings.set(row.polymarket_condition_id, row.kalshi_ticker);
      }

      logger.info('Loaded event mappings', { count: result.rows.length });
    } catch (error) {
      logger.error('Failed to load mappings', { error: (error as Error).message });
    }
  }

  /**
   * Find Kalshi equivalent for a Polymarket event
   */
  async findKalshiEquivalent(
    polymarket: PolymarketMarket,
    kalshiMarkets: KalshiMarket[]
  ): Promise<EventMapping | null> {
    // Check cached/manual mappings first
    const cached = this.cachedMappings.get(polymarket.conditionId);
    if (cached && cached.isActive) {
      return cached;
    }

    const config = getConfig();

    // Try to find a match
    const normalizedPolyTitle = normalize(polymarket.title);

    for (const kalshi of kalshiMarkets) {
      const normalizedKalshiTitle = normalize(kalshi.title);

      // 1. Exact match
      if (normalizedPolyTitle === normalizedKalshiTitle) {
        const mapping = this.createMapping(
          polymarket,
          kalshi,
          1.0,
          'exact'
        );
        await this.saveMapping(mapping);
        return mapping;
      }

      // 2. Fuzzy match
      const similarity = levenshteinSimilarity(normalizedPolyTitle, normalizedKalshiTitle);

      if (similarity >= config.matching.fuzzyMatchMinSimilarity) {
        // Additional validation: dates must align
        if (config.matching.requireDateValidation) {
          const dateMatches = datesMatch(
            polymarket.endDate,
            kalshi.expirationTime,
            24 * 60 * 60 * 1000 // 24 hours tolerance
          );

          if (!dateMatches) {
            logger.debug('Fuzzy match rejected: dates do not align', {
              polymarket: polymarket.conditionId,
              kalshi: kalshi.ticker,
              polyDate: polymarket.endDate,
              kalshiDate: kalshi.expirationTime,
            });
            continue;
          }
        }

        // Category validation
        if (config.matching.requireCategoryMatch) {
          if (!this.categoriesCompatible(polymarket.title, kalshi.category)) {
            logger.debug('Fuzzy match rejected: categories do not match', {
              polymarket: polymarket.conditionId,
              kalshi: kalshi.ticker,
              kalshiCategory: kalshi.category,
            });
            continue;
          }
        }

        const mapping = this.createMapping(
          polymarket,
          kalshi,
          similarity,
          'fuzzy'
        );
        await this.saveMapping(mapping);
        return mapping;
      }
    }

    return null;
  }

  /**
   * Check if categories are compatible
   */
  private categoriesCompatible(polymarketTitle: string, kalshiCategory: string): boolean {
    const normalizedTitle = normalize(polymarketTitle);
    const normalizedCategory = normalize(kalshiCategory);

    // Find the category group for Kalshi
    for (const [_group, keywords] of Object.entries(CATEGORY_MAPPINGS)) {
      const kalshiInGroup = keywords.some(kw => normalizedCategory.includes(kw));

      if (kalshiInGroup) {
        // Check if Polymarket title contains any keyword from this group
        const polyInGroup = keywords.some(kw => normalizedTitle.includes(kw));
        return polyInGroup;
      }
    }

    // If category not recognized, allow the match
    return true;
  }

  /**
   * Create an event mapping
   */
  private createMapping(
    polymarket: PolymarketMarket,
    kalshi: KalshiMarket,
    confidence: number,
    method: MatchMethod
  ): EventMapping {
    // Default outcome mapping: YES maps to yes, NO maps to no
    const outcomeMapping: OutcomeMapping[] = [
      { polymarketOutcome: 'Yes', kalshiSide: 'yes' },
      { polymarketOutcome: 'No', kalshiSide: 'no' },
    ];

    return {
      id: generateId(),
      polymarketConditionId: polymarket.conditionId,
      kalshiTicker: kalshi.ticker,
      eventDescription: polymarket.title,
      matchConfidence: confidence,
      resolutionDate: polymarket.endDate,
      matchMethod: method,
      outcomeMapping,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /**
   * Save mapping to database
   */
  private async saveMapping(mapping: EventMapping): Promise<void> {
    try {
      await query(
        `INSERT INTO event_mappings
         (id, polymarket_condition_id, kalshi_ticker, description, match_confidence, match_method, resolution_date, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (polymarket_condition_id, kalshi_ticker)
         DO UPDATE SET match_confidence = $5, updated_at = NOW()`,
        [
          mapping.id,
          mapping.polymarketConditionId,
          mapping.kalshiTicker,
          mapping.eventDescription,
          mapping.matchConfidence,
          mapping.matchMethod,
          mapping.resolutionDate,
          mapping.isActive,
        ]
      );

      // Update cache
      this.cachedMappings.set(mapping.polymarketConditionId, mapping);

      logger.info('Saved event mapping', {
        polymarket: mapping.polymarketConditionId,
        kalshi: mapping.kalshiTicker,
        confidence: mapping.matchConfidence,
        method: mapping.matchMethod,
      });
    } catch (error) {
      logger.error('Failed to save mapping', { error: (error as Error).message });
    }
  }

  /**
   * Add a manual mapping
   */
  async addManualMapping(
    polymarketConditionId: string,
    kalshiTicker: string,
    description?: string
  ): Promise<EventMapping> {
    const mapping: EventMapping = {
      id: generateId(),
      polymarketConditionId,
      kalshiTicker,
      eventDescription: description || '',
      matchConfidence: 1.0,
      resolutionDate: new Date(),
      matchMethod: 'manual',
      outcomeMapping: [
        { polymarketOutcome: 'Yes', kalshiSide: 'yes' },
        { polymarketOutcome: 'No', kalshiSide: 'no' },
      ],
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.saveMapping(mapping);
    this.manualMappings.set(polymarketConditionId, kalshiTicker);

    return mapping;
  }

  /**
   * Remove a mapping
   */
  async removeMapping(polymarketConditionId: string): Promise<void> {
    try {
      await query(
        'UPDATE event_mappings SET is_active = false WHERE polymarket_condition_id = $1',
        [polymarketConditionId]
      );

      this.cachedMappings.delete(polymarketConditionId);
      this.manualMappings.delete(polymarketConditionId);

      logger.info('Removed event mapping', { polymarketConditionId });
    } catch (error) {
      logger.error('Failed to remove mapping', { error: (error as Error).message });
    }
  }

  /**
   * Get all active mappings
   */
  getActiveMappings(): EventMapping[] {
    return Array.from(this.cachedMappings.values()).filter(m => m.isActive);
  }

  /**
   * Get mapping by Polymarket condition ID
   */
  getMapping(polymarketConditionId: string): EventMapping | null {
    return this.cachedMappings.get(polymarketConditionId) || null;
  }

  /**
   * Get match confidence for a mapping
   */
  getMatchConfidence(mapping: EventMapping): number {
    return mapping.matchConfidence;
  }

  /**
   * Check if mapping meets minimum confidence threshold
   */
  canTradeOnMapping(mapping: EventMapping): boolean {
    const config = getConfig();

    if (mapping.matchConfidence < config.matching.minConfidenceThreshold) {
      logger.warn('Rejecting trade: confidence below threshold', {
        mapping: mapping.id,
        confidence: mapping.matchConfidence,
        threshold: config.matching.minConfidenceThreshold,
      });
      return false;
    }

    return true;
  }

  /**
   * Build mappings from current markets
   */
  async buildMappings(
    polymarketMarkets: PolymarketMarket[],
    kalshiMarkets: KalshiMarket[]
  ): Promise<EventMapping[]> {
    const mappings: EventMapping[] = [];

    for (const polymarket of polymarketMarkets) {
      const mapping = await this.findKalshiEquivalent(polymarket, kalshiMarkets);
      if (mapping) {
        mappings.push(mapping);
      }
    }

    logger.info('Built event mappings', {
      polymarketCount: polymarketMarkets.length,
      kalshiCount: kalshiMarkets.length,
      mappingsFound: mappings.length,
    });

    return mappings;
  }
}

// Singleton instance
let eventMatcher: EventMatcher | null = null;

export function getEventMatcher(): EventMatcher {
  if (!eventMatcher) {
    eventMatcher = new EventMatcher();
  }
  return eventMatcher;
}
