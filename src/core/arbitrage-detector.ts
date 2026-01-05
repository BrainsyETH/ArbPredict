import type {
  ArbitrageOpportunity,
  EventMapping,
  OrderBook,
  Platform,
  ProfitCalculation,
} from '../types/index.js';
import { getConfig } from '../config/index.js';
import { getPolymarketConnector } from '../connectors/polymarket/index.js';
import { getKalshiConnector } from '../connectors/kalshi/index.js';
import { getEventMatcher } from './event-matcher.js';
import { createChildLogger } from '../utils/logger.js';
import { generateId, round } from '../utils/helpers.js';

const logger = createChildLogger('arbitrage-detector');

/**
 * Fee estimator for both platforms
 */
function estimateFees(
  buyPlatform: Platform,
  sellPlatform: Platform,
  buyPrice: number,
  sellPrice: number,
  quantity: number
): number {
  let fees = 0;

  // Polymarket fees: ~2% taker fee
  if (buyPlatform === 'polymarket') {
    fees += buyPrice * quantity * 0.02;
  }
  if (sellPlatform === 'polymarket') {
    fees += (1 - sellPrice) * quantity * 0.02; // Fee on winnings
  }

  // Kalshi fees: 7% on profits, capped at $0.07 per contract
  if (buyPlatform === 'kalshi') {
    // No fee on buy
  }
  if (sellPlatform === 'kalshi') {
    const potentialProfit = (1 - sellPrice) * quantity;
    fees += Math.min(potentialProfit * 0.07, 0.07 * quantity);
  }

  return fees;
}

/**
 * Calculate detailed profit breakdown
 */
export function calculateProfitDetails(
  buyPlatform: Platform,
  sellPlatform: Platform,
  buyPrice: number,
  sellPrice: number,
  quantity: number
): ProfitCalculation {
  const config = getConfig();
  const grossProfit = (sellPrice - buyPrice) * quantity;

  // Platform fees
  let polymarketFees = 0;
  let kalshiFees = 0;

  if (buyPlatform === 'polymarket') {
    polymarketFees += buyPrice * quantity * 0.02;
  }
  if (sellPlatform === 'polymarket') {
    polymarketFees += (1 - sellPrice) * quantity * 0.02;
  }

  if (sellPlatform === 'kalshi') {
    const potentialProfit = (1 - sellPrice) * quantity;
    kalshiFees += Math.min(potentialProfit * 0.07, 0.07 * quantity);
  }

  // Gas cost (Polygon is cheap)
  const gasCost = buyPlatform === 'polymarket' || sellPlatform === 'polymarket'
    ? config.smallPosition.estimatedGasCostUsd * 2
    : 0;

  const totalFees = polymarketFees + kalshiFees + gasCost;
  const netProfit = grossProfit - totalFees;
  const tradeValue = buyPrice * quantity;
  const profitPercentage = tradeValue > 0 ? netProfit / tradeValue : 0;

  return {
    grossProfit,
    polymarketFees,
    kalshiFees,
    gasCost,
    netProfit,
    profitPercentage,
  };
}

/**
 * Arbitrage opportunity detector
 */
export class ArbitrageDetector {
  private lastOpportunities: Map<string, ArbitrageOpportunity> = new Map();

  /**
   * Detect arbitrage opportunity from order books
   */
  detectArbitrage(
    polymarketBook: OrderBook,
    kalshiBook: OrderBook,
    mapping: EventMapping
  ): ArbitrageOpportunity | null {
    const config = getConfig();

    // Get best prices
    // Polymarket: prices are 0-1 (dollars)
    // Kalshi: prices are 0-1 after conversion from cents
    const polyYesBid = polymarketBook.bids[0]?.price || 0;
    const polyYesAsk = polymarketBook.asks[0]?.price || 1;
    const kalshiYesBid = kalshiBook.bids[0]?.price || 0;
    const kalshiYesAsk = kalshiBook.asks[0]?.price || 1;

    // Get available sizes
    const polyBidSize = polymarketBook.bids[0]?.size || 0;
    const polyAskSize = polymarketBook.asks[0]?.size || 0;
    const kalshiBidSize = kalshiBook.bids[0]?.size || 0;
    const kalshiAskSize = kalshiBook.asks[0]?.size || 0;

    let opportunity: ArbitrageOpportunity | null = null;

    // Case 1: Buy on Polymarket, Sell on Kalshi
    // Buy YES on Poly at ask, sell YES on Kalshi at bid
    if (polyYesAsk < kalshiYesBid) {
      const spread = kalshiYesBid - polyYesAsk;
      const maxQuantity = Math.min(polyAskSize, kalshiBidSize);
      const fees = estimateFees('polymarket', 'kalshi', polyYesAsk, kalshiYesBid, 1);

      if (spread > fees + config.trading.minProfitThreshold * polyYesAsk) {
        opportunity = this.createOpportunity(
          mapping,
          'polymarket',
          polyYesAsk,
          polyAskSize,
          'kalshi',
          kalshiYesBid,
          kalshiBidSize,
          spread,
          fees,
          maxQuantity
        );
      }
    }

    // Case 2: Buy on Kalshi, Sell on Polymarket
    // Buy YES on Kalshi at ask, sell YES on Poly at bid
    if (kalshiYesAsk < polyYesBid) {
      const spread = polyYesBid - kalshiYesAsk;
      const maxQuantity = Math.min(kalshiAskSize, polyBidSize);
      const fees = estimateFees('kalshi', 'polymarket', kalshiYesAsk, polyYesBid, 1);

      if (spread > fees + config.trading.minProfitThreshold * kalshiYesAsk) {
        const newOpportunity = this.createOpportunity(
          mapping,
          'kalshi',
          kalshiYesAsk,
          kalshiAskSize,
          'polymarket',
          polyYesBid,
          polyBidSize,
          spread,
          fees,
          maxQuantity
        );

        // If we already have an opportunity, pick the more profitable one
        if (!opportunity || newOpportunity.netProfit > opportunity.netProfit) {
          opportunity = newOpportunity;
        }
      }
    }

    // Validate opportunity if found
    if (opportunity) {
      // Check minimum profit threshold
      const profitPct = opportunity.netProfit / opportunity.buyPrice;
      if (profitPct < config.trading.minProfitThreshold) {
        logger.debug('Opportunity below profit threshold', {
          profitPct: round(profitPct * 100, 2) + '%',
          threshold: config.trading.minProfitThreshold * 100 + '%',
        });
        return null;
      }

      // Check minimum liquidity
      if (opportunity.maxQuantity < config.risk.minLiquidityDepth) {
        logger.debug('Opportunity has insufficient liquidity', {
          available: opportunity.maxQuantity,
          required: config.risk.minLiquidityDepth,
        });
        return null;
      }

      // Cache this opportunity
      this.lastOpportunities.set(mapping.id, opportunity);

      logger.info('Arbitrage opportunity detected', {
        id: opportunity.id,
        buyPlatform: opportunity.buyPlatform,
        buyPrice: round(opportunity.buyPrice, 4),
        sellPlatform: opportunity.sellPlatform,
        sellPrice: round(opportunity.sellPrice, 4),
        spread: round(opportunity.grossSpread, 4),
        netProfit: round(opportunity.netProfit, 4),
        maxQty: opportunity.maxQuantity,
      });
    }

    return opportunity;
  }

  /**
   * Create an opportunity object
   */
  private createOpportunity(
    mapping: EventMapping,
    buyPlatform: Platform,
    buyPrice: number,
    buyQuantity: number,
    sellPlatform: Platform,
    sellPrice: number,
    sellQuantity: number,
    grossSpread: number,
    estimatedFees: number,
    maxQuantity: number
  ): ArbitrageOpportunity {
    return {
      id: generateId(),
      timestamp: new Date(),
      eventMapping: mapping,
      buyPlatform,
      buyPrice,
      buyQuantity,
      sellPlatform,
      sellPrice,
      sellQuantity,
      grossSpread,
      estimatedFees,
      netProfit: grossSpread - estimatedFees,
      maxQuantity,
      executionRisk: this.calculateExecutionRisk(maxQuantity, buyPrice),
      expirationTime: new Date(Date.now() + 5000), // Opportunities expire in 5 seconds
    };
  }

  /**
   * Calculate execution risk based on liquidity
   */
  private calculateExecutionRisk(quantity: number, price: number): number {
    // Lower liquidity = higher risk
    // Risk ranges from 0 (no risk) to 1 (high risk)
    const config = getConfig();

    if (quantity >= config.risk.minLiquidityDepth * 2) {
      return 0.1; // Low risk
    } else if (quantity >= config.risk.minLiquidityDepth) {
      return 0.3; // Medium risk
    } else {
      return 0.6; // Higher risk
    }
  }

  /**
   * Scan all mapped events for opportunities
   */
  async scanForOpportunities(): Promise<ArbitrageOpportunity[]> {
    const eventMatcher = getEventMatcher();
    const polymarketConnector = getPolymarketConnector();
    const kalshiConnector = getKalshiConnector();

    const mappings = eventMatcher.getActiveMappings();
    const opportunities: ArbitrageOpportunity[] = [];

    for (const mapping of mappings) {
      // Check if we can trade on this mapping
      if (!eventMatcher.canTradeOnMapping(mapping)) {
        continue;
      }

      try {
        // Fetch order books from both platforms
        // For Polymarket, we need the YES token ID
        // This is a simplified version - in production, we'd cache token IDs
        const polyBook = await polymarketConnector.getOrderBook(
          mapping.polymarketConditionId
        );
        const kalshiBook = await kalshiConnector.getOrderBook(
          mapping.kalshiTicker
        );

        const opportunity = this.detectArbitrage(polyBook, kalshiBook, mapping);
        if (opportunity) {
          opportunities.push(opportunity);
        }
      } catch (error) {
        logger.debug('Failed to fetch order books for mapping', {
          mapping: mapping.id,
          error: (error as Error).message,
        });
      }
    }

    return opportunities;
  }

  /**
   * Get last opportunity for a mapping
   */
  getLastOpportunity(mappingId: string): ArbitrageOpportunity | null {
    const opp = this.lastOpportunities.get(mappingId);

    // Check if expired
    if (opp && opp.expirationTime < new Date()) {
      this.lastOpportunities.delete(mappingId);
      return null;
    }

    return opp || null;
  }

  /**
   * Validate that an opportunity is still valid
   */
  async validateOpportunity(opportunity: ArbitrageOpportunity): Promise<boolean> {
    const config = getConfig();

    // Check if expired
    if (opportunity.expirationTime < new Date()) {
      logger.debug('Opportunity expired', { id: opportunity.id });
      return false;
    }

    // Fetch fresh order books
    const polymarketConnector = getPolymarketConnector();
    const kalshiConnector = getKalshiConnector();

    try {
      const polyBook = await polymarketConnector.getOrderBook(
        opportunity.eventMapping.polymarketConditionId
      );
      const kalshiBook = await kalshiConnector.getOrderBook(
        opportunity.eventMapping.kalshiTicker
      );

      // Check if spread still exists
      const freshOpportunity = this.detectArbitrage(
        polyBook,
        kalshiBook,
        opportunity.eventMapping
      );

      if (!freshOpportunity) {
        logger.debug('Opportunity no longer valid', { id: opportunity.id });
        return false;
      }

      // Check if profit hasn't deteriorated too much (slippage check)
      const profitRatio = freshOpportunity.netProfit / opportunity.netProfit;
      if (profitRatio < 1 - config.trading.maxSlippage) {
        logger.debug('Opportunity profit deteriorated', {
          id: opportunity.id,
          originalProfit: opportunity.netProfit,
          currentProfit: freshOpportunity.netProfit,
        });
        return false;
      }

      return true;
    } catch (error) {
      logger.error('Failed to validate opportunity', {
        id: opportunity.id,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Clear expired opportunities
   */
  clearExpired(): void {
    const now = new Date();
    for (const [id, opp] of this.lastOpportunities) {
      if (opp.expirationTime < now) {
        this.lastOpportunities.delete(id);
      }
    }
  }
}

// Singleton instance
let arbitrageDetector: ArbitrageDetector | null = null;

export function getArbitrageDetector(): ArbitrageDetector {
  if (!arbitrageDetector) {
    arbitrageDetector = new ArbitrageDetector();
  }
  return arbitrageDetector;
}
