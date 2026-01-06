import type {
  ArbitrageOpportunity,
  RiskCheck,
  Position,
  InventoryReport,
  Platform,
} from '../types/index.js';
import { getConfig } from '../config/index.js';
import { getStateManager } from './state.js';
import { getCircuitBreaker } from './circuit-breaker.js';
import { createChildLogger } from '../utils/logger.js';
import { round, formatUsd } from '../utils/helpers.js';

const logger = createChildLogger('risk-manager');

/**
 * Risk manager for the arbitrage bot
 * Enforces position limits, exposure limits, and daily loss limits
 */
export class RiskManager {
  private positions: Map<string, Position[]> = new Map();
  private totalExposure: number = 0;

  /**
   * Pre-trade risk validation
   */
  validateTrade(opportunity: ArbitrageOpportunity, quantity: number): RiskCheck {
    const config = getConfig();
    const stateManager = getStateManager();
    const circuitBreaker = getCircuitBreaker();

    const checks: string[] = [];
    const warnings: string[] = [];

    // 1. Check circuit breaker
    if (circuitBreaker.isPaused()) {
      checks.push(`Circuit breaker is paused: ${circuitBreaker.getPauseReason()}`);
    }

    // 2. Calculate trade value
    const tradeValue = quantity * opportunity.buyPrice;

    // 3. Check total exposure
    if (this.totalExposure + tradeValue > config.risk.maxTotalExposure) {
      checks.push(
        `Total exposure would exceed ${formatUsd(config.risk.maxTotalExposure)} limit ` +
        `(current: ${formatUsd(this.totalExposure)}, trade: ${formatUsd(tradeValue)})`
      );
    }

    // 4. Check per-event exposure
    const eventId = opportunity.eventMapping.id;
    const eventExposure = this.getEventExposure(eventId);
    if (eventExposure + tradeValue > config.risk.maxExposurePerEvent) {
      checks.push(
        `Event exposure would exceed ${formatUsd(config.risk.maxExposurePerEvent)} limit ` +
        `(current: ${formatUsd(eventExposure)}, trade: ${formatUsd(tradeValue)})`
      );
    }

    // 5. Check position imbalance
    const inventory = this.getNetInventory(eventId);
    if (Math.abs(inventory.imbalanceUsd) > config.risk.maxPositionImbalance) {
      checks.push(
        `Position imbalance exceeds ${formatUsd(config.risk.maxPositionImbalance)} ` +
        `(current: ${formatUsd(inventory.imbalanceUsd)})`
      );
    }

    // 6. Check daily loss limit
    const dailyPnL = stateManager.getDailyPnL();
    if (dailyPnL < -config.risk.dailyLossLimit) {
      checks.push(`Daily loss limit of ${formatUsd(config.risk.dailyLossLimit)} reached`);
    }

    // 7. Check profit threshold
    const profitPct = opportunity.netProfit / opportunity.buyPrice;
    if (profitPct < config.risk.minProfitThreshold) {
      checks.push(
        `Net profit ${round(profitPct * 100, 2)}% below ` +
        `${round(config.risk.minProfitThreshold * 100, 1)}% threshold`
      );
    }

    // 8. Check trade size limits
    if (quantity > config.risk.maxQuantityPerTrade) {
      checks.push(
        `Quantity ${quantity} exceeds max ${config.risk.maxQuantityPerTrade} per trade`
      );
    }

    if (quantity < config.risk.minQuantityPerTrade) {
      checks.push(
        `Quantity ${quantity} below min ${config.risk.minQuantityPerTrade} per trade`
      );
    }

    // 9. Check small position viability
    if (tradeValue < config.smallPosition.minTradeValueUsd) {
      checks.push(
        `Trade value ${formatUsd(tradeValue)} below minimum ${formatUsd(config.smallPosition.minTradeValueUsd)}`
      );
    }

    const estimatedProfit = quantity * opportunity.netProfit;
    if (estimatedProfit < config.smallPosition.minProfitUsd) {
      checks.push(
        `Estimated profit ${formatUsd(estimatedProfit)} below minimum ${formatUsd(config.smallPosition.minProfitUsd)}`
      );
    }

    // 10. Check liquidity warnings
    if (opportunity.maxQuantity < config.risk.minLiquidityDepth) {
      warnings.push(
        `Low liquidity: only ${opportunity.maxQuantity} available (min: ${config.risk.minLiquidityDepth})`
      );
    }

    // 11. Check execution risk
    if (opportunity.executionRisk > 0.5) {
      warnings.push(`High execution risk: ${round(opportunity.executionRisk * 100, 0)}%`);
    }

    // Calculate suggested quantity if limits would be hit
    let suggestedQuantity = quantity;

    // Reduce if total exposure would be exceeded
    const remainingExposure = config.risk.maxTotalExposure - this.totalExposure;
    if (remainingExposure > 0 && tradeValue > remainingExposure) {
      suggestedQuantity = Math.floor(remainingExposure / opportunity.buyPrice);
    }

    // Reduce if event exposure would be exceeded
    const remainingEventExposure = config.risk.maxExposurePerEvent - eventExposure;
    if (remainingEventExposure > 0 && tradeValue > remainingEventExposure) {
      const eventSuggestedQty = Math.floor(remainingEventExposure / opportunity.buyPrice);
      suggestedQuantity = Math.min(suggestedQuantity, eventSuggestedQty);
    }

    // Cap at max quantity per trade
    suggestedQuantity = Math.min(suggestedQuantity, config.risk.maxQuantityPerTrade);

    const approved = checks.length === 0;

    if (!approved) {
      logger.warn('Trade rejected by risk manager', {
        opportunityId: opportunity.id,
        checks,
        warnings,
      });
    } else if (warnings.length > 0) {
      logger.info('Trade approved with warnings', {
        opportunityId: opportunity.id,
        warnings,
      });
    }

    return {
      approved,
      reasons: checks.length > 0 ? checks : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      suggestedQuantity: suggestedQuantity > 0 ? suggestedQuantity : undefined,
    };
  }

  /**
   * Calculate optimal trade quantity
   */
  calculateOptimalQuantity(opportunity: ArbitrageOpportunity): number {
    const config = getConfig();

    // Start with max quantity available in the order book
    let quantity = Math.min(
      opportunity.buyQuantity,
      opportunity.sellQuantity,
      opportunity.maxQuantity
    );

    // Cap at max per trade
    quantity = Math.min(quantity, config.risk.maxQuantityPerTrade);

    // Cap based on remaining exposure
    const remainingExposure = config.risk.maxTotalExposure - this.totalExposure;
    if (remainingExposure > 0) {
      const maxFromExposure = Math.floor(remainingExposure / opportunity.buyPrice);
      quantity = Math.min(quantity, maxFromExposure);
    }

    // Ensure minimum
    quantity = Math.max(quantity, config.risk.minQuantityPerTrade);

    return Math.floor(quantity);
  }

  /**
   * Get event exposure
   */
  getEventExposure(eventId: string): number {
    const positions = this.positions.get(eventId) || [];
    return positions.reduce((sum, pos) => sum + pos.quantity * pos.avgPrice, 0);
  }

  /**
   * Get total exposure
   */
  getTotalExposure(): number {
    return this.totalExposure;
  }

  /**
   * Get net inventory for an event
   */
  getNetInventory(eventId: string): InventoryReport {
    const positions = this.positions.get(eventId) || [];

    let polymarketYesQty = 0;
    let polymarketNoQty = 0;
    let kalshiYesQty = 0;
    let kalshiNoQty = 0;

    for (const pos of positions) {
      if (pos.platform === 'polymarket') {
        if (pos.side === 'yes') polymarketYesQty += pos.quantity;
        else polymarketNoQty += pos.quantity;
      } else {
        if (pos.side === 'yes') kalshiYesQty += pos.quantity;
        else kalshiNoQty += pos.quantity;
      }
    }

    const netPosition = (polymarketYesQty + kalshiYesQty) - (polymarketNoQty + kalshiNoQty);
    const avgPrice = positions.length > 0
      ? positions.reduce((sum, p) => sum + p.avgPrice, 0) / positions.length
      : 0.5;
    const imbalanceUsd = Math.abs(netPosition) * avgPrice;

    const config = getConfig();
    const needsRebalancing = imbalanceUsd > config.risk.maxPositionImbalance;

    return {
      eventId,
      polymarketYesQty,
      polymarketNoQty,
      kalshiYesQty,
      kalshiNoQty,
      netPosition,
      imbalanceUsd,
      needsRebalancing,
    };
  }

  /**
   * Record a new position
   */
  addPosition(position: Position): void {
    const eventId = position.eventId;
    const existing = this.positions.get(eventId) || [];
    existing.push(position);
    this.positions.set(eventId, existing);

    this.recalculateTotalExposure();

    logger.debug('Position added', {
      eventId,
      platform: position.platform,
      side: position.side,
      quantity: position.quantity,
    });
  }

  /**
   * Update positions from connectors
   */
  updatePositions(positions: Position[]): void {
    this.positions.clear();

    for (const pos of positions) {
      const existing = this.positions.get(pos.eventId) || [];
      existing.push(pos);
      this.positions.set(pos.eventId, existing);
    }

    this.recalculateTotalExposure();

    logger.debug('Positions updated', { count: positions.length });
  }

  /**
   * Recalculate total exposure
   */
  private recalculateTotalExposure(): void {
    this.totalExposure = 0;
    for (const positions of this.positions.values()) {
      for (const pos of positions) {
        this.totalExposure += pos.quantity * pos.avgPrice;
      }
    }
  }

  /**
   * Check if daily loss limit is reached
   */
  isDailyLossLimitReached(): boolean {
    const config = getConfig();
    const stateManager = getStateManager();
    return stateManager.getDailyPnL() < -config.risk.dailyLossLimit;
  }

  /**
   * Get available capital on a platform
   */
  getAvailableCapital(_platform: Platform): number {
    const config = getConfig();
    const remainingExposure = config.risk.maxTotalExposure - this.totalExposure;
    // Split remaining exposure between platforms (simplified)
    return remainingExposure / 2;
  }

  /**
   * Check if trade reduces imbalance (for inventory-aware trading)
   */
  tradeReducesImbalance(eventId: string, buyPlatform: Platform): boolean {
    const inventory = this.getNetInventory(eventId);

    if (!inventory.needsRebalancing) {
      return false; // No rebalancing needed
    }

    // If net position is positive (long YES), we want to sell on the platform with more YES
    // If net position is negative (short YES), we want to buy on the platform with less YES
    if (inventory.netPosition > 0) {
      // We're long YES, prefer selling on the platform with more YES inventory
      if (buyPlatform === 'polymarket') {
        // Buying on Poly, selling on Kalshi - reduces if Kalshi has more YES
        return inventory.kalshiYesQty > inventory.polymarketYesQty;
      } else {
        // Buying on Kalshi, selling on Poly - reduces if Poly has more YES
        return inventory.polymarketYesQty > inventory.kalshiYesQty;
      }
    } else {
      // We're short YES (or neutral), prefer buying to increase YES
      return true; // Any arb trade helps balance
    }
  }
}

// Singleton instance
let riskManager: RiskManager | null = null;

export function getRiskManager(): RiskManager {
  if (!riskManager) {
    riskManager = new RiskManager();
  }
  return riskManager;
}
