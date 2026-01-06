import axios, { type AxiosInstance, type AxiosError } from 'axios';
import WebSocket from 'ws';
import type {
  Platform,
  OrderBook,
  OrderBookUpdate,
  LimitOrder,
  OrderResult,
  Balances,
  Position,
  KalshiMarket,
} from '../../types/index.js';
import type { BaseConnector } from '../base.js';
import { RateLimiter } from '../base.js';
import { getConfig } from '../../config/index.js';
import { createChildLogger } from '../../utils/logger.js';
import { generateId, withRetry, sleep } from '../../utils/helpers.js';
import type {
  KalshiApiMarket,
  KalshiOrderBookResponse,
  KalshiOrderRequest,
  KalshiOrderResponse,
  KalshiMarketsResponse,
  KalshiPositionsResponse,
  KalshiBalanceResponse,
  KalshiOrderBookUpdate,
  KalshiWebSocketSubscribe,
} from './types.js';
import { validateCredentials, getAuthHeaders, isAuthenticated, clearSession } from './auth.js';

const logger = createChildLogger('kalshi');

export class KalshiConnector implements BaseConnector {
  readonly platform: Platform = 'kalshi';

  private client: AxiosInstance;
  private ws: WebSocket | null = null;
  private connected: boolean = false;
  private wsConnected: boolean = false;
  private readRateLimiter: RateLimiter;
  private writeRateLimiter: RateLimiter;
  private subscriptions: Map<string, (update: OrderBookUpdate) => void> = new Map();
  private lastHeartbeat: Date | null = null;
  private reconnectAttempts: number = 0;
  private readonly maxReconnectAttempts: number = 5;
  private wsMessageId: number = 1;
  private orderBooks: Map<string, OrderBook> = new Map();

  constructor() {
    const config = getConfig();

    this.client = axios.create({
      baseURL: config.kalshi.apiBase,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add auth interceptor - signs each request with RSA key
    this.client.interceptors.request.use(async (reqConfig) => {
      const method = reqConfig.method?.toUpperCase() || 'GET';
      // Build full path including the base path
      const basePath = '/trade-api/v2';
      const requestPath = reqConfig.url?.startsWith('/') ? reqConfig.url : `/${reqConfig.url}`;
      const fullPath = `${basePath}${requestPath}`;

      const authHeaders = getAuthHeaders(method, fullPath);
      Object.entries(authHeaders).forEach(([key, value]) => {
        reqConfig.headers[key] = value;
      });

      return reqConfig;
    });

    // Rate limiters based on Kalshi's standard tier limits
    this.readRateLimiter = new RateLimiter(
      config.rateLimits.kalshi.readPerSecond,
      1,
      config.rateLimits.kalshi.minRequestIntervalMs
    );

    this.writeRateLimiter = new RateLimiter(
      config.rateLimits.kalshi.writePerSecond,
      1,
      config.rateLimits.kalshi.minRequestIntervalMs
    );
  }

  async connect(): Promise<boolean> {
    try {
      // Validate API key credentials
      if (!validateCredentials()) {
        logger.error('Failed to validate Kalshi API credentials');
        return false;
      }

      // Test connection by making a simple API call
      try {
        await this.readRateLimiter.waitForSlot();
        await this.client.get('/exchange/status');
        this.connected = true;
        logger.info('Connected to Kalshi REST API');
        return true;
      } catch (error) {
        // If exchange/status fails, try another endpoint
        logger.debug('Exchange status check failed, trying markets endpoint');
        await this.readRateLimiter.waitForSlot();
        await this.client.get('/markets?limit=1');
        this.connected = true;
        logger.info('Connected to Kalshi REST API');
        return true;
      }
    } catch (error) {
      logger.error('Failed to connect to Kalshi', {
        error: (error as Error).message,
      });
      return false;
    }
  }

  async connectWebSocket(): Promise<boolean> {
    const config = getConfig();

    if (!isAuthenticated()) {
      logger.error('Must be authenticated before connecting WebSocket');
      return false;
    }

    return new Promise((resolve) => {
      try {
        const wsUrl = `${config.kalshi.wsUrl}`;
        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
          this.wsConnected = true;
          this.reconnectAttempts = 0;
          this.lastHeartbeat = new Date();
          logger.info('WebSocket connected to Kalshi');

          // Authenticate the WebSocket connection
          this.authenticateWebSocket();

          resolve(true);
        });

        this.ws.on('message', (data: Buffer) => {
          this.lastHeartbeat = new Date();
          this.handleWebSocketMessage(data.toString());
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          this.wsConnected = false;
          logger.warn('WebSocket disconnected from Kalshi', {
            code,
            reason: reason.toString(),
          });
          this.handleWebSocketDisconnect();
        });

        this.ws.on('error', (error: Error) => {
          logger.error('Kalshi WebSocket error', { error: error.message });
        });

        // Timeout if connection takes too long
        setTimeout(() => {
          if (!this.wsConnected) {
            logger.error('WebSocket connection timeout');
            resolve(false);
          }
        }, 10000);
      } catch (error) {
        logger.error('Failed to create WebSocket connection', {
          error: (error as Error).message,
        });
        resolve(false);
      }
    });
  }

  private authenticateWebSocket(): void {
    if (!this.ws || !isAuthenticated()) return;

    // For API key auth, we authenticate using signed headers
    // The WebSocket auth command expects the same signature format
    const method = 'GET';
    const path = '/trade-api/ws/v2';

    const authHeaders = getAuthHeaders(method, path);

    const authMessage = {
      id: this.wsMessageId++,
      cmd: 'authenticate',
      params: {
        api_key: authHeaders['KALSHI-ACCESS-KEY'],
        timestamp: authHeaders['KALSHI-ACCESS-TIMESTAMP'],
        signature: authHeaders['KALSHI-ACCESS-SIGNATURE'],
      },
    };

    this.ws.send(JSON.stringify(authMessage));
    logger.debug('Sent WebSocket authentication');
  }

  private handleWebSocketMessage(data: string): void {
    try {
      const message = JSON.parse(data);

      if (message.type === 'orderbook_snapshot' || message.type === 'orderbook_delta') {
        this.processOrderBookUpdate(message as KalshiOrderBookUpdate);
      }
    } catch (error) {
      logger.debug('Failed to parse WebSocket message', {
        error: (error as Error).message,
      });
    }
  }

  private processOrderBookUpdate(update: KalshiOrderBookUpdate): void {
    const ticker = update.msg.market_ticker;
    const handler = this.subscriptions.get(ticker);

    // Build order book from update
    const orderBook: OrderBook = {
      bids: update.msg.yes.map(l => ({
        price: l.price / 100, // Convert cents to dollars
        size: l.quantity,
      })),
      asks: update.msg.no.map(l => ({
        price: l.price / 100,
        size: l.quantity,
      })),
      timestamp: new Date(),
    };

    // Cache the order book
    this.orderBooks.set(ticker, orderBook);

    if (handler) {
      handler({
        platform: 'kalshi',
        marketId: ticker,
        book: orderBook,
      });
    }
  }

  private async handleWebSocketDisconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max WebSocket reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const config = getConfig();
    const delay = Math.min(
      config.websocket.initialDelayMs * Math.pow(config.websocket.backoffMultiplier, this.reconnectAttempts - 1),
      config.websocket.maxDelayMs
    );

    logger.info(`Attempting WebSocket reconnection in ${delay}ms (attempt ${this.reconnectAttempts})`);

    await sleep(delay);

    const success = await this.connectWebSocket();
    if (success) {
      // Resubscribe to all markets
      for (const ticker of this.subscriptions.keys()) {
        await this.subscribeToMarket(ticker);
      }
    }
  }

  async subscribeToMarket(
    ticker: string,
    handler?: (update: OrderBookUpdate) => void
  ): Promise<void> {
    if (!this.wsConnected || !this.ws) {
      logger.warn('WebSocket not connected, cannot subscribe');
      return;
    }

    if (handler) {
      this.subscriptions.set(ticker, handler);
    }

    const subscribeMessage: KalshiWebSocketSubscribe = {
      id: this.wsMessageId++,
      cmd: 'subscribe',
      params: {
        channels: ['orderbook_delta'],
        market_tickers: [ticker],
      },
    };

    this.ws.send(JSON.stringify(subscribeMessage));
    logger.debug('Subscribed to Kalshi market', { ticker });
  }

  async unsubscribeFromMarket(ticker: string): Promise<void> {
    if (!this.wsConnected || !this.ws) {
      return;
    }

    this.subscriptions.delete(ticker);

    const unsubscribeMessage = {
      id: this.wsMessageId++,
      cmd: 'unsubscribe',
      params: {
        channels: ['orderbook_delta'],
        market_tickers: [ticker],
      },
    };

    this.ws.send(JSON.stringify(unsubscribeMessage));
    logger.debug('Unsubscribed from Kalshi market', { ticker });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    clearSession();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.wsConnected = false;
    }

    this.subscriptions.clear();
    this.orderBooks.clear();
    logger.info('Disconnected from Kalshi');
  }

  isConnected(): boolean {
    return this.connected && isAuthenticated();
  }

  isWebSocketConnected(): boolean {
    return this.wsConnected;
  }

  getLastHeartbeat(): Date | null {
    return this.lastHeartbeat;
  }

  async getMarkets(status: 'open' | 'closed' | 'settled' = 'open'): Promise<KalshiMarket[]> {
    const config = getConfig();
    const allMarkets: KalshiMarket[] = [];
    let cursor: string | undefined;

    try {
      do {
        await this.readRateLimiter.waitForSlot();

        const response = await withRetry(
          () => this.client.get<KalshiMarketsResponse>('/markets', {
            params: {
              status,
              limit: 100,
              cursor,
            },
          }),
          config.retry.api,
          'Kalshi getMarkets'
        );

        const markets = response.data.markets.map(this.transformMarket);
        allMarkets.push(...markets);
        cursor = response.data.cursor;
      } while (cursor);

      return allMarkets;
    } catch (error) {
      logger.error('Failed to get markets', { error: (error as Error).message });
      throw error;
    }
  }

  async getMarket(ticker: string): Promise<KalshiMarket | null> {
    const config = getConfig();

    try {
      await this.readRateLimiter.waitForSlot();

      const response = await withRetry(
        () => this.client.get<{ market: KalshiApiMarket }>(`/markets/${ticker}`),
        config.retry.api,
        'Kalshi getMarket'
      );

      return this.transformMarket(response.data.market);
    } catch (error) {
      if ((error as AxiosError).response?.status === 404) {
        return null;
      }
      logger.error('Failed to get market', {
        ticker,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  private transformMarket(apiMarket: KalshiApiMarket): KalshiMarket {
    return {
      id: apiMarket.ticker,
      ticker: apiMarket.ticker,
      title: apiMarket.title,
      category: apiMarket.category,
      yesPrice: apiMarket.yes_ask / 100, // Convert cents to dollars
      noPrice: apiMarket.no_ask / 100,
      volume: apiMarket.volume,
      openInterest: apiMarket.open_interest,
      endDate: new Date(apiMarket.close_time),
      expirationTime: new Date(apiMarket.expiration_time),
      settlementTime: new Date(apiMarket.expiration_time),
    };
  }

  async getOrderBook(ticker: string): Promise<OrderBook> {
    const config = getConfig();

    try {
      await this.readRateLimiter.waitForSlot();

      const startTime = Date.now();
      const response = await withRetry(
        () => this.client.get<KalshiOrderBookResponse>(`/markets/${ticker}/orderbook`),
        config.retry.api,
        'Kalshi getOrderBook'
      );

      const latency = Date.now() - startTime;
      if (latency > config.latency.orderbookFetchTargetMs) {
        logger.warn('Orderbook fetch latency exceeded target', {
          latency,
          target: config.latency.orderbookFetchTargetMs,
        });
      }

      const orderBook: OrderBook = {
        bids: response.data.orderbook.yes.map(l => ({
          price: l.price / 100, // Convert cents to dollars
          size: l.quantity,
        })),
        asks: response.data.orderbook.no.map(l => ({
          price: l.price / 100,
          size: l.quantity,
        })),
        timestamp: new Date(),
      };

      // Cache the order book
      this.orderBooks.set(ticker, orderBook);

      return orderBook;
    } catch (error) {
      logger.error('Failed to get order book', {
        ticker,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  async placeLimitOrder(order: LimitOrder): Promise<OrderResult> {
    const config = getConfig();

    try {
      await this.writeRateLimiter.waitForSlot();

      // Kalshi uses cents for prices
      const priceInCents = Math.round(order.price * 100);

      const orderRequest: KalshiOrderRequest = {
        ticker: order.marketId,
        action: order.side === 'buy' ? 'buy' : 'sell',
        side: 'yes', // We trade YES side by default
        type: 'limit',
        count: Math.floor(order.quantity),
        yes_price: priceInCents,
        client_order_id: generateId(),
        // Map order types to Kalshi time_in_force
        time_in_force: order.orderType === 'FOK' ? 'fok' : 'gtc',
      };

      const startTime = Date.now();
      const response = await this.client.post<{ order: KalshiOrderResponse }>(
        '/portfolio/orders',
        orderRequest
      );

      const latency = Date.now() - startTime;
      if (latency > config.latency.orderPlacementMaxMs) {
        logger.error('Order placement latency exceeded maximum', {
          latency,
          max: config.latency.orderPlacementMaxMs,
        });
      }

      const orderResult = response.data.order;

      // For FOK orders, check if fully filled
      if (order.orderType === 'FOK') {
        if (orderResult.status === 'executed' && orderResult.remaining_count === 0) {
          const fillPrice = (orderResult.taker_fill_cost || 0) /
            (orderResult.taker_fill_count || 1) / 100;

          return {
            success: true,
            orderId: orderResult.order_id,
            fillPrice,
            fillQuantity: orderResult.taker_fill_count || order.quantity,
            fees: (orderResult.taker_fees || 0) / 100,
            timestamp: new Date(orderResult.created_time),
          };
        } else {
          // FOK order was not fully filled
          return {
            success: false,
            orderId: orderResult.order_id,
            timestamp: new Date(),
            error: 'FOK order not filled',
          };
        }
      }

      return {
        success: true,
        orderId: orderResult.order_id,
        timestamp: new Date(orderResult.created_time),
      };
    } catch (error) {
      logger.error('Failed to place order', {
        order,
        error: (error as Error).message,
      });

      return {
        success: false,
        orderId: '',
        timestamp: new Date(),
        error: (error as Error).message,
      };
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    try {
      await this.writeRateLimiter.waitForSlot();
      await this.client.delete(`/portfolio/orders/${orderId}`);
      logger.debug('Order cancelled', { orderId });
    } catch (error) {
      logger.error('Failed to cancel order', {
        orderId,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  async getBalances(): Promise<Balances> {
    try {
      await this.readRateLimiter.waitForSlot();

      const response = await this.client.get<KalshiBalanceResponse>('/portfolio/balance');

      const balanceUsd = response.data.balance / 100; // Convert cents to dollars

      return {
        platform: 'kalshi',
        available: balanceUsd,
        locked: 0, // Would need to calculate from open orders
        total: balanceUsd,
        currency: 'USD',
      };
    } catch (error) {
      logger.error('Failed to get balances', { error: (error as Error).message });
      return {
        platform: 'kalshi',
        available: 0,
        locked: 0,
        total: 0,
        currency: 'USD',
      };
    }
  }

  async getPositions(): Promise<Position[]> {
    try {
      await this.readRateLimiter.waitForSlot();

      const response = await this.client.get<KalshiPositionsResponse>('/portfolio/positions');

      return response.data.market_positions
        .filter(pos => pos.position !== 0) // Only open positions
        .map(pos => ({
          id: generateId(),
          platform: 'kalshi' as Platform,
          eventId: pos.ticker,
          side: pos.position > 0 ? 'yes' : 'no' as 'yes' | 'no',
          quantity: Math.abs(pos.position),
          avgPrice: pos.total_cost / Math.abs(pos.position) / 100,
          currentPrice: 0, // Would need to fetch current market price
          unrealizedPnL: 0, // Would need to calculate
          openedAt: new Date(),
          updatedAt: new Date(),
        }));
    } catch (error) {
      logger.error('Failed to get positions', { error: (error as Error).message });
      return [];
    }
  }

  /**
   * Get cached order book (from WebSocket updates)
   */
  getCachedOrderBook(ticker: string): OrderBook | null {
    return this.orderBooks.get(ticker) || null;
  }
}

// Export singleton instance
let instance: KalshiConnector | null = null;

export function getKalshiConnector(): KalshiConnector {
  if (!instance) {
    instance = new KalshiConnector();
  }
  return instance;
}
