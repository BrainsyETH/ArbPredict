import type {
  ArbitrageOpportunity,
  ExecutionResult,
  OrderResult,
  LimitOrder,
  Position,
} from '../types/index.js';
import { getConfig } from '../config/index.js';
import { getPolymarketConnector } from '../connectors/polymarket/index.js';
import { getKalshiConnector } from '../connectors/kalshi/index.js';
import { getCircuitBreaker } from './circuit-breaker.js';
import { getRiskManager } from './risk-manager.js';
import { getStateManager } from './state.js';
import { getArbitrageDetector } from './arbitrage-detector.js';
import { getTelegramAlerter } from './alerts.js';
import { query } from '../db/index.js';
import { createChildLogger } from '../utils/logger.js';
import { generateId, round, calculateSlippage } from '../utils/helpers.js';

const logger = createChildLogger('execution-engine');

/**
 * Execution engine for arbitrage trades
 * Uses FOK (Fill-or-Kill) orders exclusively
 */
export class ExecutionEngine {
  private paused: boolean = false;

  /**
   * Execute an arbitrage opportunity
   */
  async execute(opportunity: ArbitrageOpportunity): Promise<ExecutionResult> {
    const config = getConfig();
    const circuitBreaker = getCircuitBreaker();
    const riskManager = getRiskManager();
    const stateManager = getStateManager();
    const arbitrageDetector = getArbitrageDetector();
    const alerter = getTelegramAlerter();

    // 1. Check if paused
    if (circuitBreaker.isPaused()) {
      return {
        success: false,
        buyExecution: null,
        sellExecution: null,
        actualProfit: 0,
        slippage: 0,
        errors: [`Circuit breaker active: ${circuitBreaker.getPauseReason()}`],
        circuitBreakerTriggered: true,
      };
    }

    // 2. Calculate optimal quantity
    const quantity = riskManager.calculateOptimalQuantity(opportunity);

    // 3. Validate risk
    const riskCheck = riskManager.validateTrade(opportunity, quantity);
    if (!riskCheck.approved) {
      return {
        success: false,
        buyExecution: null,
        sellExecution: null,
        actualProfit: 0,
        slippage: 0,
        errors: riskCheck.reasons,
        circuitBreakerTriggered: false,
      };
    }

    // Use suggested quantity if different
    const finalQuantity = riskCheck.suggestedQuantity || quantity;

    // 4. Validate opportunity is still valid
    const stillValid = await arbitrageDetector.validateOpportunity(opportunity);
    if (!stillValid) {
      return {
        success: false,
        buyExecution: null,
        sellExecution: null,
        actualProfit: 0,
        slippage: 0,
        errors: ['Opportunity no longer valid'],
        circuitBreakerTriggered: false,
      };
    }

    // 5. Check if dry run mode
    if (config.operatingMode.mode === 'dry_run') {
      return this.executeDryRun(opportunity, finalQuantity);
    }

    // 6. Execute both legs simultaneously with FOK orders
    const buyOrder: LimitOrder = {
      platform: opportunity.buyPlatform,
      marketId: opportunity.buyPlatform === 'polymarket'
        ? opportunity.eventMapping.polymarketConditionId
        : opportunity.eventMapping.kalshiTicker,
      side: 'buy',
      price: opportunity.buyPrice,
      quantity: finalQuantity,
      orderType: 'FOK',
    };

    const sellOrder: LimitOrder = {
      platform: opportunity.sellPlatform,
      marketId: opportunity.sellPlatform === 'polymarket'
        ? opportunity.eventMapping.polymarketConditionId
        : opportunity.eventMapping.kalshiTicker,
      side: 'sell',
      price: opportunity.sellPrice,
      quantity: finalQuantity,
      orderType: 'FOK',
    };

    logger.info('Executing arbitrage', {
      opportunityId: opportunity.id,
      buyPlatform: buyOrder.platform,
      buyPrice: buyOrder.price,
      sellPlatform: sellOrder.platform,
      sellPrice: sellOrder.price,
      quantity: finalQuantity,
    });

    const startTime = Date.now();

    // Execute both orders in parallel
    const [buyResult, sellResult] = await Promise.allSettled([
      this.placeOrder(buyOrder),
      this.placeOrder(sellOrder),
    ]);

    const executionTime = Date.now() - startTime;

    // Check latency
    if (executionTime > config.latency.endToEndMaxMs) {
      logger.warn('Execution latency exceeded maximum', {
        executionTime,
        max: config.latency.endToEndMaxMs,
      });
    }

    // 7. Process results
    const buySuccess = buyResult.status === 'fulfilled' && buyResult.value.success;
    const sellSuccess = sellResult.status === 'fulfilled' && sellResult.value.success;

    const buyExecution = buyResult.status === 'fulfilled' ? buyResult.value : null;
    const sellExecution = sellResult.status === 'fulfilled' ? sellResult.value : null;

    // Both succeeded - perfect execution
    if (buySuccess && sellSuccess) {
      const actualProfit = this.calculateActualProfit(
        buyExecution!,
        sellExecution!,
        finalQuantity
      );

      const slippage = calculateSlippage(
        opportunity.netProfit * finalQuantity,
        actualProfit
      );

      // Record success
      circuitBreaker.recordSuccess();
      stateManager.recordSuccessfulTrade(
        actualProfit,
        finalQuantity * opportunity.buyPrice
      );

      // Record positions
      this.recordPositions(opportunity, finalQuantity, buyExecution!, sellExecution!);

      // Save execution to database
      await this.saveExecution(
        opportunity,
        'complete',
        buyExecution!,
        sellExecution!,
        actualProfit,
        slippage
      );

      logger.info('Arbitrage executed successfully', {
        opportunityId: opportunity.id,
        actualProfit: round(actualProfit, 4),
        slippage: round(slippage * 100, 2) + '%',
        executionTime,
      });

      // Send alert (medium priority for successful trades)
      await alerter.alertTradeExecuted({
        buyPlatform: opportunity.buyPlatform,
        buyPrice: buyExecution!.fillPrice || opportunity.buyPrice,
        sellPlatform: opportunity.sellPlatform,
        sellPrice: sellExecution!.fillPrice || opportunity.sellPrice,
        profit: actualProfit,
      });

      return {
        success: true,
        buyExecution,
        sellExecution,
        actualProfit,
        slippage,
        circuitBreakerTriggered: false,
      };
    }

    // Both failed (FOK rejected) - expected behavior, no action needed
    if (!buySuccess && !sellSuccess) {
      logger.info('Both FOK orders rejected - opportunity expired', {
        opportunityId: opportunity.id,
        buyError: buyExecution?.error,
        sellError: sellExecution?.error,
      });

      return {
        success: false,
        buyExecution,
        sellExecution,
        actualProfit: 0,
        slippage: 0,
        errors: ['Both FOK orders rejected - opportunity expired'],
        circuitBreakerTriggered: false,
      };
    }

    // CRITICAL: Asymmetric execution - one succeeded, one failed
    logger.error('CRITICAL: Asymmetric FOK execution', {
      opportunityId: opportunity.id,
      buySuccess,
      sellSuccess,
      buyResult: buyExecution,
      sellResult: sellExecution,
    });

    // Trigger circuit breaker
    circuitBreaker.recordFailure('ASYMMETRIC_EXECUTION');

    // Send critical alert
    await alerter.alertAsymmetricExecution({
      buyResult: buySuccess ? 'FILLED' : 'REJECTED',
      sellResult: sellSuccess ? 'FILLED' : 'REJECTED',
      buyPlatform: opportunity.buyPlatform,
      sellPlatform: opportunity.sellPlatform,
    });

    // Save failed execution
    await this.saveExecution(
      opportunity,
      'failed',
      buyExecution,
      sellExecution,
      0,
      0,
      'Asymmetric execution'
    );

    return {
      success: false,
      buyExecution,
      sellExecution,
      actualProfit: 0,
      slippage: 0,
      errors: ['Asymmetric execution - circuit breaker triggered'],
      circuitBreakerTriggered: true,
    };
  }

  /**
   * Execute in dry run mode
   */
  private async executeDryRun(
    opportunity: ArbitrageOpportunity,
    quantity: number
  ): Promise<ExecutionResult> {
    const stateManager = getStateManager();
    const config = getConfig();

    logger.info('[DRY RUN] Would execute arbitrage', {
      opportunityId: opportunity.id,
      buyPlatform: opportunity.buyPlatform,
      buyPrice: opportunity.buyPrice,
      sellPlatform: opportunity.sellPlatform,
      sellPrice: opportunity.sellPrice,
      quantity,
      estimatedProfit: opportunity.netProfit * quantity,
    });

    // Track hypothetical P&L
    if (config.operatingMode.trackHypotheticalPnL) {
      const hypotheticalProfit = opportunity.netProfit * quantity;
      stateManager.recordSuccessfulTrade(
        hypotheticalProfit,
        quantity * opportunity.buyPrice
      );
    }

    // Save dry run execution to database
    await this.saveExecution(
      opportunity,
      'complete',
      {
        success: true,
        orderId: 'DRY_RUN_' + generateId(),
        fillPrice: opportunity.buyPrice,
        fillQuantity: quantity,
        timestamp: new Date(),
      },
      {
        success: true,
        orderId: 'DRY_RUN_' + generateId(),
        fillPrice: opportunity.sellPrice,
        fillQuantity: quantity,
        timestamp: new Date(),
      },
      opportunity.netProfit * quantity,
      0,
      undefined,
      true
    );

    return {
      success: true,
      buyExecution: null,
      sellExecution: null,
      actualProfit: opportunity.netProfit * quantity,
      slippage: 0,
      circuitBreakerTriggered: false,
      dryRun: true,
    };
  }

  /**
   * Place an order on the appropriate platform
   */
  private async placeOrder(order: LimitOrder): Promise<OrderResult> {
    if (order.platform === 'polymarket') {
      const connector = getPolymarketConnector();
      return connector.placeLimitOrder(order);
    } else {
      const connector = getKalshiConnector();
      return connector.placeLimitOrder(order);
    }
  }

  /**
   * Calculate actual profit from executions
   */
  private calculateActualProfit(
    buyExecution: OrderResult,
    sellExecution: OrderResult,
    quantity: number
  ): number {
    const buyPrice = buyExecution.fillPrice || 0;
    const sellPrice = sellExecution.fillPrice || 0;
    const buyFees = buyExecution.fees || 0;
    const sellFees = sellExecution.fees || 0;

    const grossProfit = (sellPrice - buyPrice) * quantity;
    const totalFees = buyFees + sellFees;

    return grossProfit - totalFees;
  }

  /**
   * Record positions from execution
   */
  private recordPositions(
    opportunity: ArbitrageOpportunity,
    quantity: number,
    buyExecution: OrderResult,
    sellExecution: OrderResult
  ): void {
    const riskManager = getRiskManager();

    // Buy position
    const buyPosition: Position = {
      id: generateId(),
      platform: opportunity.buyPlatform,
      eventId: opportunity.eventMapping.id,
      eventMappingId: opportunity.eventMapping.id,
      side: 'yes',
      quantity,
      avgPrice: buyExecution.fillPrice || opportunity.buyPrice,
      currentPrice: buyExecution.fillPrice || opportunity.buyPrice,
      unrealizedPnL: 0,
      openedAt: new Date(),
      updatedAt: new Date(),
    };

    // Sell position (short YES = long NO conceptually)
    const sellPosition: Position = {
      id: generateId(),
      platform: opportunity.sellPlatform,
      eventId: opportunity.eventMapping.id,
      eventMappingId: opportunity.eventMapping.id,
      side: 'no', // Selling YES = effectively NO position
      quantity,
      avgPrice: sellExecution.fillPrice || opportunity.sellPrice,
      currentPrice: sellExecution.fillPrice || opportunity.sellPrice,
      unrealizedPnL: 0,
      openedAt: new Date(),
      updatedAt: new Date(),
    };

    riskManager.addPosition(buyPosition);
    riskManager.addPosition(sellPosition);
  }

  /**
   * Save execution to database
   */
  private async saveExecution(
    opportunity: ArbitrageOpportunity,
    status: 'pending' | 'partial' | 'complete' | 'failed',
    buyExecution: OrderResult | null,
    sellExecution: OrderResult | null,
    actualProfit: number,
    slippage: number,
    notes?: string,
    isDryRun: boolean = false
  ): Promise<void> {
    try {
      // First save the opportunity
      await query(
        `INSERT INTO opportunities
         (id, event_mapping_id, buy_platform, buy_price, buy_quantity, sell_platform, sell_price, sell_quantity, gross_spread, estimated_fees, net_profit, was_executed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO NOTHING`,
        [
          opportunity.id,
          opportunity.eventMapping.id,
          opportunity.buyPlatform,
          opportunity.buyPrice,
          opportunity.buyQuantity,
          opportunity.sellPlatform,
          opportunity.sellPrice,
          opportunity.sellQuantity,
          opportunity.grossSpread,
          opportunity.estimatedFees,
          opportunity.netProfit,
          status === 'complete',
        ]
      );

      // Then save the execution
      await query(
        `INSERT INTO executions
         (id, opportunity_id, status, buy_order_id, buy_fill_price, buy_fill_quantity, buy_fees, buy_platform, sell_order_id, sell_fill_price, sell_fill_quantity, sell_fees, sell_platform, actual_profit, slippage, notes, is_dry_run)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          generateId(),
          opportunity.id,
          status,
          buyExecution?.orderId,
          buyExecution?.fillPrice,
          buyExecution?.fillQuantity,
          buyExecution?.fees,
          opportunity.buyPlatform,
          sellExecution?.orderId,
          sellExecution?.fillPrice,
          sellExecution?.fillQuantity,
          sellExecution?.fees,
          opportunity.sellPlatform,
          actualProfit,
          slippage,
          notes,
          isDryRun,
        ]
      );

      logger.debug('Execution saved to database', {
        opportunityId: opportunity.id,
        status,
        isDryRun,
      });
    } catch (error) {
      logger.error('Failed to save execution', { error: (error as Error).message });
    }
  }

  /**
   * Pause execution
   */
  pause(reason: string): void {
    this.paused = true;
    logger.info('Execution paused', { reason });
  }

  /**
   * Resume execution
   */
  resume(): void {
    this.paused = false;
    logger.info('Execution resumed');
  }

  /**
   * Check if paused
   */
  isPaused(): boolean {
    return this.paused || getCircuitBreaker().isPaused();
  }
}

// Singleton instance
let executionEngine: ExecutionEngine | null = null;

export function getExecutionEngine(): ExecutionEngine {
  if (!executionEngine) {
    executionEngine = new ExecutionEngine();
  }
  return executionEngine;
}
