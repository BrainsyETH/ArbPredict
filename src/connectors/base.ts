import type {
  Platform,
  OrderBook,
  LimitOrder,
  OrderResult,
  Balances,
  Position,
  ReconnectionPolicy,
} from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';

const logger = createChildLogger('connector-base');

/**
 * Base connector interface for platform connectors
 */
export interface BaseConnector {
  readonly platform: Platform;

  // Connection management
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Market data
  getMarkets(): Promise<unknown[]>;
  getOrderBook(marketId: string): Promise<OrderBook>;

  // Trading
  placeLimitOrder(order: LimitOrder): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;

  // Account
  getBalances(): Promise<Balances>;
  getPositions(): Promise<Position[]>;
}

/**
 * WebSocket manager for real-time data
 */
export abstract class WebSocketManager {
  protected ws: WebSocket | null = null;
  protected connected: boolean = false;
  protected reconnecting: boolean = false;
  protected lastHeartbeat: Date | null = null;
  protected heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  protected reconnectAttempts: number = 0;
  protected messageHandlers: Map<string, (data: unknown) => void> = new Map();

  constructor(
    protected readonly platform: Platform,
    protected readonly wsUrl: string,
    protected readonly policy: ReconnectionPolicy
  ) {}

  abstract onOpen(): void;
  abstract onMessage(data: unknown): void;
  abstract onClose(code: number, reason: string): void;
  abstract onError(error: Error): void;

  async connect(): Promise<boolean> {
    this.reconnectAttempts = 0;
    return this.attemptConnection();
  }

  protected async attemptConnection(): Promise<boolean> {
    while (this.reconnectAttempts < this.policy.maxAttempts) {
      try {
        await this.establishConnection();
        this.connected = true;
        this.reconnectAttempts = 0;
        this.startHeartbeatMonitor();

        logger.info(`WebSocket connected to ${this.platform}`);
        return true;
      } catch (error) {
        this.reconnectAttempts++;

        const delay = Math.min(
          this.policy.initialDelayMs * Math.pow(this.policy.backoffMultiplier, this.reconnectAttempts - 1),
          this.policy.maxDelayMs
        );

        logger.warn(
          `WebSocket connection attempt ${this.reconnectAttempts} failed for ${this.platform}. Retrying in ${delay}ms`,
          { error: (error as Error).message }
        );

        await sleep(delay);
      }
    }

    logger.error(`WebSocket reconnection failed after ${this.policy.maxAttempts} attempts`);
    return false;
  }

  protected abstract establishConnection(): Promise<void>;

  protected startHeartbeatMonitor(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.lastHeartbeat) {
        const timeSinceHeartbeat = Date.now() - this.lastHeartbeat.getTime();

        if (timeSinceHeartbeat > this.policy.heartbeatTimeoutMs) {
          logger.error('WebSocket heartbeat timeout - connection presumed dead');
          this.handleDisconnect();
        }
      }
    }, this.policy.heartbeatIntervalMs);
  }

  protected handleDisconnect(): void {
    this.connected = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (!this.reconnecting) {
      this.reconnecting = true;
      logger.info('Attempting WebSocket reconnection...');

      this.attemptConnection()
        .then((success) => {
          if (!success) {
            logger.error('WebSocket reconnection failed');
          }
        })
        .finally(() => {
          this.reconnecting = false;
        });
    }
  }

  updateHeartbeat(): void {
    this.lastHeartbeat = new Date();
  }

  isConnected(): boolean {
    return this.connected;
  }

  getLastHeartbeat(): Date | null {
    return this.lastHeartbeat;
  }

  async disconnect(): Promise<void> {
    this.connected = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    logger.info(`WebSocket disconnected from ${this.platform}`);
  }
}

/**
 * Rate limiter for API calls
 */
export class RateLimiter {
  private requests: number[] = [];
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly minIntervalMs: number;
  private lastRequestTime: number = 0;

  constructor(
    maxRequestsPerWindow: number,
    windowSeconds: number,
    minIntervalMs: number
  ) {
    this.maxRequests = maxRequestsPerWindow;
    this.windowMs = windowSeconds * 1000;
    this.minIntervalMs = minIntervalMs;
  }

  async waitForSlot(): Promise<void> {
    // Clean up old requests
    const now = Date.now();
    this.requests = this.requests.filter(t => now - t < this.windowMs);

    // Wait for minimum interval
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minIntervalMs) {
      await sleep(this.minIntervalMs - timeSinceLastRequest);
    }

    // Wait if at rate limit
    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = this.windowMs - (now - oldestRequest);
      if (waitTime > 0) {
        logger.debug(`Rate limit reached, waiting ${waitTime}ms`);
        await sleep(waitTime);
      }
      this.requests.shift();
    }

    // Record this request
    this.requests.push(Date.now());
    this.lastRequestTime = Date.now();
  }

  getRequestCount(): number {
    const now = Date.now();
    this.requests = this.requests.filter(t => now - t < this.windowMs);
    return this.requests.length;
  }
}
