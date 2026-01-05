import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies
vi.mock('../../src/config/index.js', () => ({
  getConfig: () => ({
    risk: {
      maxConsecutiveFailures: 3,
      maxAsymmetricExecutions: 1,
      dailyLossLimit: 20,
    },
  }),
}));

vi.mock('../../src/core/state.js', () => ({
  getStateManager: () => ({
    setCircuitBreakerState: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    getState: () => ({
      circuitBreakerPaused: false,
      circuitBreakerReason: null,
    }),
  }),
}));

vi.mock('../../src/core/alerts.js', () => ({
  getTelegramAlerter: () => ({
    alertCircuitBreaker: vi.fn().mockResolvedValue(undefined),
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

import { CircuitBreaker } from '../../src/core/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker;

  beforeEach(() => {
    circuitBreaker = new CircuitBreaker();
  });

  describe('pause/resume', () => {
    it('should start in unpaused state', () => {
      expect(circuitBreaker.isPaused()).toBe(false);
    });

    it('should pause when pause is called', () => {
      circuitBreaker.pause('Test pause');

      expect(circuitBreaker.isPaused()).toBe(true);
      expect(circuitBreaker.getPauseReason()).toBe('Test pause');
      expect(circuitBreaker.getPausedAt()).not.toBeNull();
    });

    it('should resume when resume is called', () => {
      circuitBreaker.pause('Test pause');
      circuitBreaker.resume();

      expect(circuitBreaker.isPaused()).toBe(false);
      expect(circuitBreaker.getPauseReason()).toBeNull();
      expect(circuitBreaker.getPausedAt()).toBeNull();
    });

    it('should not double-pause', () => {
      circuitBreaker.pause('First pause');
      const firstPausedAt = circuitBreaker.getPausedAt();

      circuitBreaker.pause('Second pause');

      expect(circuitBreaker.getPauseReason()).toBe('First pause');
      expect(circuitBreaker.getPausedAt()).toBe(firstPausedAt);
    });
  });

  describe('failure tracking', () => {
    it('should track consecutive failures', () => {
      circuitBreaker.recordFailure('EXECUTION_FAILURE');
      expect(circuitBreaker.getConsecutiveFailures()).toBe(1);

      circuitBreaker.recordFailure('EXECUTION_FAILURE');
      expect(circuitBreaker.getConsecutiveFailures()).toBe(2);
    });

    it('should reset failures on success', () => {
      circuitBreaker.recordFailure('EXECUTION_FAILURE');
      circuitBreaker.recordFailure('EXECUTION_FAILURE');
      circuitBreaker.recordSuccess();

      expect(circuitBreaker.getConsecutiveFailures()).toBe(0);
    });

    it('should auto-pause after max consecutive failures', () => {
      circuitBreaker.recordFailure('EXECUTION_FAILURE');
      circuitBreaker.recordFailure('EXECUTION_FAILURE');
      circuitBreaker.recordFailure('EXECUTION_FAILURE'); // 3rd failure

      expect(circuitBreaker.isPaused()).toBe(true);
      expect(circuitBreaker.getPauseReason()).toContain('consecutive failures');
    });

    it('should track asymmetric executions', () => {
      circuitBreaker.recordFailure('ASYMMETRIC_EXECUTION');

      expect(circuitBreaker.getAsymmetricExecutions()).toBe(1);
      expect(circuitBreaker.isPaused()).toBe(true);
    });

    it('should pause on daily loss limit', () => {
      circuitBreaker.recordFailure('DAILY_LOSS_LIMIT');

      expect(circuitBreaker.isPaused()).toBe(true);
      expect(circuitBreaker.getPauseReason()).toBe('Daily loss limit reached');
    });

    it('should pause on connection lost', () => {
      circuitBreaker.recordFailure('CONNECTION_LOST');

      expect(circuitBreaker.isPaused()).toBe(true);
      expect(circuitBreaker.getPauseReason()).toBe('Connection lost to exchange');
    });
  });

  describe('status', () => {
    it('should return complete status', () => {
      circuitBreaker.recordFailure('EXECUTION_FAILURE');
      circuitBreaker.recordFailure('ASYMMETRIC_EXECUTION');

      const status = circuitBreaker.getStatus();

      expect(status.paused).toBe(true);
      expect(status.consecutiveFailures).toBe(2);
      expect(status.asymmetricExecutions).toBe(1);
      expect(status.reason).not.toBeNull();
      expect(status.pausedAt).not.toBeNull();
    });

    it('should reset counters on resume', () => {
      circuitBreaker.recordFailure('EXECUTION_FAILURE');
      circuitBreaker.recordFailure('EXECUTION_FAILURE');
      circuitBreaker.recordFailure('EXECUTION_FAILURE');
      circuitBreaker.resume();

      expect(circuitBreaker.getConsecutiveFailures()).toBe(0);
      expect(circuitBreaker.getAsymmetricExecutions()).toBe(0);
    });
  });
});
