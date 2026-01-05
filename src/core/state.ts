import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import type { PersistedState, Position } from '../types/index.js';
import { getConfig } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { getTodayString, deepClone } from '../utils/helpers.js';

const logger = createChildLogger('state');

/**
 * State manager for persisting bot state across restarts
 */
export class StateManager {
  private state: PersistedState;
  private autoSaveTimer: NodeJS.Timer | null = null;
  private readonly filePath: string;

  constructor() {
    const config = getConfig();
    this.filePath = config.state.filePath;
    this.state = this.createInitialState();
  }

  /**
   * Load state from file
   */
  async load(): Promise<PersistedState> {
    try {
      if (!existsSync(this.filePath)) {
        logger.info('No existing state file, starting fresh');
        return this.state;
      }

      const data = await readFile(this.filePath, 'utf-8');
      this.state = JSON.parse(data);

      // Check if we need to reset daily counters
      const today = getTodayString();
      if (this.state.tradingDate !== today) {
        logger.info('New trading day: resetting daily counters', {
          previousDate: this.state.tradingDate,
          newDate: today,
        });
        this.state.dailyPnL = 0;
        this.state.dailyTradeCount = 0;
        this.state.dailyVolumeUsd = 0;
        this.state.tradingDate = today;
      }

      logger.info('State loaded', {
        dailyPnL: this.state.dailyPnL,
        circuitBreakerPaused: this.state.circuitBreakerPaused,
        openPositions: this.state.openPositions.length,
        lastHeartbeat: this.state.lastHeartbeat,
      });

      return this.state;
    } catch (error) {
      logger.error('Failed to load state', { error: (error as Error).message });
      return this.state;
    }
  }

  /**
   * Save state to file
   */
  async save(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      this.state.lastHeartbeat = new Date().toISOString();
      await writeFile(this.filePath, JSON.stringify(this.state, null, 2));
      logger.debug('State saved');
    } catch (error) {
      logger.error('Failed to save state', { error: (error as Error).message });
    }
  }

  /**
   * Start auto-save timer
   */
  startAutoSave(): void {
    const config = getConfig();
    const intervalMs = config.state.autoSaveIntervalSeconds * 1000;

    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
    }

    this.autoSaveTimer = setInterval(() => {
      this.save().catch(err => {
        logger.error('Auto-save failed', { error: err.message });
      });
    }, intervalMs);

    logger.info('Auto-save started', { intervalSeconds: config.state.autoSaveIntervalSeconds });
  }

  /**
   * Stop auto-save timer
   */
  stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
      logger.info('Auto-save stopped');
    }
  }

  /**
   * Get current state (read-only copy)
   */
  getState(): Readonly<PersistedState> {
    return deepClone(this.state);
  }

  /**
   * Update daily P&L
   */
  updateDailyPnL(amount: number): void {
    this.state.dailyPnL += amount;
    logger.debug('Daily P&L updated', { newPnL: this.state.dailyPnL, change: amount });
  }

  /**
   * Increment trade count
   */
  incrementTradeCount(): void {
    this.state.dailyTradeCount++;
  }

  /**
   * Add to daily volume
   */
  addVolume(amount: number): void {
    this.state.dailyVolumeUsd += amount;
  }

  /**
   * Record successful trade
   */
  recordSuccessfulTrade(profit: number, volume: number): void {
    this.updateDailyPnL(profit);
    this.incrementTradeCount();
    this.addVolume(volume);
    this.state.lastSuccessfulTrade = new Date().toISOString();
  }

  /**
   * Get daily P&L
   */
  getDailyPnL(): number {
    return this.state.dailyPnL;
  }

  /**
   * Get daily trade count
   */
  getDailyTradeCount(): number {
    return this.state.dailyTradeCount;
  }

  /**
   * Set circuit breaker state
   */
  setCircuitBreakerState(paused: boolean, reason: string | null): void {
    this.state.circuitBreakerPaused = paused;
    this.state.circuitBreakerReason = reason;
    this.state.circuitBreakerPausedAt = paused ? new Date().toISOString() : null;
  }

  /**
   * Check if circuit breaker is paused
   */
  isCircuitBreakerPaused(): boolean {
    return this.state.circuitBreakerPaused;
  }

  /**
   * Get circuit breaker reason
   */
  getCircuitBreakerReason(): string | null {
    return this.state.circuitBreakerReason;
  }

  /**
   * Update open positions
   */
  setOpenPositions(positions: Position[]): void {
    this.state.openPositions = positions;
  }

  /**
   * Get open positions
   */
  getOpenPositions(): Position[] {
    return deepClone(this.state.openPositions);
  }

  /**
   * Get state age in minutes
   */
  getStateAgeMinutes(): number {
    if (!this.state.lastHeartbeat) return Infinity;
    const lastHeartbeat = new Date(this.state.lastHeartbeat);
    return (Date.now() - lastHeartbeat.getTime()) / (1000 * 60);
  }

  /**
   * Create initial empty state
   */
  private createInitialState(): PersistedState {
    return {
      dailyPnL: 0,
      dailyTradeCount: 0,
      dailyVolumeUsd: 0,
      tradingDate: getTodayString(),
      circuitBreakerPaused: false,
      circuitBreakerReason: null,
      circuitBreakerPausedAt: null,
      openPositions: [],
      lastHeartbeat: new Date().toISOString(),
      lastSuccessfulTrade: null,
    };
  }

  /**
   * Reset state (for testing)
   */
  reset(): void {
    this.state = this.createInitialState();
    logger.info('State reset');
  }
}

// Singleton instance
let stateManager: StateManager | null = null;

export function getStateManager(): StateManager {
  if (!stateManager) {
    stateManager = new StateManager();
  }
  return stateManager;
}
