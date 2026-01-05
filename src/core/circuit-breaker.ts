import type { FailureType } from '../types/index.js';
import { getConfig } from '../config/index.js';
import { getStateManager } from './state.js';
import { createChildLogger } from '../utils/logger.js';
import { getTelegramAlerter } from './alerts.js';

const logger = createChildLogger('circuit-breaker');

/**
 * Circuit breaker implementation
 * Pauses trading when errors occur and requires manual intervention
 */
export class CircuitBreaker {
  private paused: boolean = false;
  private pauseReason: string | null = null;
  private pausedAt: Date | null = null;
  private consecutiveFailures: number = 0;
  private asymmetricExecutions: number = 0;

  /**
   * Initialize from persisted state
   */
  async initialize(): Promise<void> {
    const stateManager = getStateManager();
    const state = stateManager.getState();

    this.paused = state.circuitBreakerPaused;
    this.pauseReason = state.circuitBreakerReason;
    this.pausedAt = state.circuitBreakerPausedAt
      ? new Date(state.circuitBreakerPausedAt)
      : null;

    if (this.paused) {
      logger.warn('Circuit breaker was paused on startup', {
        reason: this.pauseReason,
        pausedAt: this.pausedAt,
      });
    }
  }

  /**
   * Record a failure and potentially trigger pause
   */
  recordFailure(type: FailureType): void {
    const config = getConfig();
    this.consecutiveFailures++;

    logger.warn('Failure recorded', {
      type,
      consecutiveFailures: this.consecutiveFailures,
    });

    if (type === 'ASYMMETRIC_EXECUTION') {
      this.asymmetricExecutions++;
    }

    // Auto-pause conditions
    if (this.consecutiveFailures >= config.risk.maxConsecutiveFailures) {
      this.pause(`${this.consecutiveFailures} consecutive failures`);
    }

    if (this.asymmetricExecutions >= config.risk.maxAsymmetricExecutions) {
      this.pause(`${this.asymmetricExecutions} asymmetric executions - manual review required`);
    }

    if (type === 'DAILY_LOSS_LIMIT') {
      this.pause('Daily loss limit reached');
    }

    if (type === 'CONNECTION_LOST') {
      this.pause('Connection lost to exchange');
    }
  }

  /**
   * Record a success and reset failure counter
   */
  recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      logger.debug('Success recorded, resetting failure counter');
    }
    this.consecutiveFailures = 0;
  }

  /**
   * Pause trading
   */
  pause(reason: string): void {
    if (this.paused) {
      logger.debug('Circuit breaker already paused', { existingReason: this.pauseReason });
      return;
    }

    this.paused = true;
    this.pauseReason = reason;
    this.pausedAt = new Date();

    logger.error('CIRCUIT BREAKER TRIGGERED', {
      reason,
      pausedAt: this.pausedAt,
    });

    // Update persisted state
    const stateManager = getStateManager();
    stateManager.setCircuitBreakerState(true, reason);
    stateManager.save().catch(err => {
      logger.error('Failed to save circuit breaker state', { error: err.message });
    });

    // Send alert
    this.sendAlert(reason);
  }

  /**
   * Resume trading
   */
  resume(): void {
    if (!this.paused) {
      logger.debug('Circuit breaker not paused');
      return;
    }

    logger.info('Circuit breaker resumed', {
      wasPausedFor: this.pauseReason,
      pausedDurationMs: this.pausedAt ? Date.now() - this.pausedAt.getTime() : 0,
    });

    this.paused = false;
    this.pauseReason = null;
    this.pausedAt = null;
    this.consecutiveFailures = 0;
    this.asymmetricExecutions = 0;

    // Update persisted state
    const stateManager = getStateManager();
    stateManager.setCircuitBreakerState(false, null);
    stateManager.save().catch(err => {
      logger.error('Failed to save circuit breaker state', { error: err.message });
    });
  }

  /**
   * Check if trading is paused
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Get pause reason
   */
  getPauseReason(): string | null {
    return this.pauseReason;
  }

  /**
   * Get paused timestamp
   */
  getPausedAt(): Date | null {
    return this.pausedAt;
  }

  /**
   * Get consecutive failure count
   */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * Get asymmetric execution count
   */
  getAsymmetricExecutions(): number {
    return this.asymmetricExecutions;
  }

  /**
   * Get status summary
   */
  getStatus(): {
    paused: boolean;
    reason: string | null;
    pausedAt: Date | null;
    consecutiveFailures: number;
    asymmetricExecutions: number;
  } {
    return {
      paused: this.paused,
      reason: this.pauseReason,
      pausedAt: this.pausedAt,
      consecutiveFailures: this.consecutiveFailures,
      asymmetricExecutions: this.asymmetricExecutions,
    };
  }

  /**
   * Send alert via Telegram
   */
  private async sendAlert(reason: string): Promise<void> {
    try {
      const alerter = getTelegramAlerter();
      await alerter.alertCircuitBreaker(reason);
    } catch (error) {
      logger.error('Failed to send circuit breaker alert', {
        error: (error as Error).message,
      });
    }
  }
}

// Singleton instance
let circuitBreaker: CircuitBreaker | null = null;

export function getCircuitBreaker(): CircuitBreaker {
  if (!circuitBreaker) {
    circuitBreaker = new CircuitBreaker();
  }
  return circuitBreaker;
}
