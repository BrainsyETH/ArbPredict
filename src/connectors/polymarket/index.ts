import axios, { type AxiosInstance, type AxiosError } from 'axios';
import WebSocket from 'ws';
import { Wallet } from 'ethers';
import type {
  Platform,
  OrderBook,
  OrderBookLevel,
  OrderBookUpdate,
  LimitOrder,
  OrderResult,
  Balances,
  Position,
  PolymarketMarket,
} from '../../types/index.js';
import type { BaseConnector, RateLimiter } from '../base.js';
import { RateLimiter as RateLimiterImpl } from '../base.js';
import { getConfig } from '../../config/index.js';
import { createChildLogger } from '../../utils/logger.js';
import { generateId, withRetry } from '../../utils/helpers.js';
import type {
  PolymarketApiMarket,
  PolymarketOrderBookResponse,
  PolymarketPositionResponse,
  PolymarketBookUpdateMessage,
  CreateOrderParams,
} from './types.js';
import { signOrder, generateNonce, getExpiration } from './auth.js';

const logger = createChildLogger('polymarket');

export class PolymarketConnector implements BaseConnector {
  readonly platform: Platform = 'polymarket';

  private client: AxiosInstance;
  private ws: WebSocket | null = null;
  private wallet: Wallet | null = null;
  private connected: boolean = false;
  private wsConnected: boolean = false;
  private rateLimiter: RateLimiter;
  private orderRateLimiter: RateLimiter;
  private subscriptions: Map<string, (update: OrderBookUpdate) => void> = new Map();
  private lastHeartbeat: Date | null = null;
  private reconnectAttempts: number = 0;
  private readonly maxReconnectAttempts: number = 5;

  constructor() {
    const config = getConfig();

    this.client = axios.create({
      baseURL: config.polymarket.clobApiUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Rate limiters
    this.rateLimiter = new RateLimiterImpl(
      config.rateLimits.polymarket.marketDataPerMinute,
      60,
      config.rateLimits.polymarket.minRequestIntervalMs
    );

    this.orderRateLimiter = new RateLimiterImpl(
      config.rateLimits.polymarket.ordersPerMinute,
      60,
      config.rateLimits.polymarket.minRequestIntervalMs
    );

    // Initialize wallet if private key provided
    if (config.polymarket.privateKey) {
      try {
        this.wallet = new Wallet(config.polymarket.privateKey);
        logger.info('Wallet initialized', { address: this.wallet.address });
      } catch (error) {
        logger.error('Failed to initialize wallet', { error: (error as Error).message });
      }
    }
  }

  async connect(): Promise<boolean> {
    try {
      // Test REST API connection
      await this.rateLimiter.waitForSlot();
      const response = await this.client.get('/markets', {
        params: { limit: 1 },
      });

      if (response.status === 200) {
        this.connected = true;
        logger.info('Connected to Polymarket REST API');
      }

      return this.connected;
    } catch (error) {
      logger.error('Failed to connect to Polymarket', {
        error: (error as Error).message,
      });
      return false;
    }
  }

  async connectWebSocket(): Promise<boolean> {
    const config = getConfig();

    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(config.polymarket.wsUrl);

        this.ws.on('open', () => {
          this.wsConnected = true;
          this.reconnectAttempts = 0;
          this.lastHeartbeat = new Date();
          logger.info('WebSocket connected to Polymarket');
          resolve(true);
        });

        this.ws.on('message', (data: Buffer) => {
          this.lastHeartbeat = new Date();
          this.handleWebSocketMessage(data.toString());
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          this.wsConnected = false;
          logger.warn('WebSocket disconnected', {
            code,
            reason: reason.toString(),
          });
          this.handleWebSocketDisconnect();
        });

        this.ws.on('error', (error: Error) => {
          logger.error('WebSocket error', { error: error.message });
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

  private handleWebSocketMessage(data: string): void {
    try {
      const message = JSON.parse(data);

      if (message.event_type === 'book') {
        const bookUpdate = message as PolymarketBookUpdateMessage;
        this.processOrderBookUpdate(bookUpdate);
      }
    } catch (error) {
      logger.debug('Failed to parse WebSocket message', {
        error: (error as Error).message,
      });
    }
  }

  private processOrderBookUpdate(update: PolymarketBookUpdateMessage): void {
    const handler = this.subscriptions.get(update.asset_id);

    if (handler) {
      const orderBook: OrderBook = {
        bids: update.bids.map(b => ({
          price: parseFloat(b.price),
          size: parseFloat(b.size),
        })),
        asks: update.asks.map(a => ({
          price: parseFloat(a.price),
          size: parseFloat(a.size),
        })),
        timestamp: new Date(update.timestamp),
      };

      handler({
        platform: 'polymarket',
        marketId: update.asset_id,
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

    setTimeout(async () => {
      const success = await this.connectWebSocket();
      if (success) {
        // Resubscribe to all markets
        for (const assetId of this.subscriptions.keys()) {
          await this.subscribeToMarket(assetId);
        }
      }
    }, delay);
  }

  async subscribeToMarket(
    assetId: string,
    handler?: (update: OrderBookUpdate) => void
  ): Promise<void> {
    if (!this.wsConnected || !this.ws) {
      logger.warn('WebSocket not connected, cannot subscribe');
      return;
    }

    if (handler) {
      this.subscriptions.set(assetId, handler);
    }

    const subscribeMessage = {
      type: 'subscribe',
      channel: 'book',
      assets_ids: [assetId],
    };

    this.ws.send(JSON.stringify(subscribeMessage));
    logger.debug('Subscribed to market', { assetId });
  }

  async unsubscribeFromMarket(assetId: string): Promise<void> {
    if (!this.wsConnected || !this.ws) {
      return;
    }

    this.subscriptions.delete(assetId);

    const unsubscribeMessage = {
      type: 'unsubscribe',
      channel: 'book',
      assets_ids: [assetId],
    };

    this.ws.send(JSON.stringify(unsubscribeMessage));
    logger.debug('Unsubscribed from market', { assetId });
  }

  async disconnect(): Promise<void> {
    this.connected = false;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.wsConnected = false;
    }

    this.subscriptions.clear();
    logger.info('Disconnected from Polymarket');
  }

  isConnected(): boolean {
    return this.connected;
  }

  isWebSocketConnected(): boolean {
    return this.wsConnected;
  }

  getLastHeartbeat(): Date | null {
    return this.lastHeartbeat;
  }

  async getMarkets(): Promise<PolymarketMarket[]> {
    const config = getConfig();

    try {
      await this.rateLimiter.waitForSlot();

      const response = await withRetry(
        () => this.client.get<PolymarketApiMarket[]>('/markets', {
          params: {
            active: true,
            closed: false,
            limit: 100,
          },
        }),
        config.retry.api,
        'Polymarket getMarkets'
      );

      return response.data.map(this.transformMarket);
    } catch (error) {
      logger.error('Failed to get markets', { error: (error as Error).message });
      throw error;
    }
  }

  async getMarket(conditionId: string): Promise<PolymarketMarket | null> {
    const config = getConfig();

    try {
      await this.rateLimiter.waitForSlot();

      const response = await withRetry(
        () => this.client.get<PolymarketApiMarket>(`/markets/${conditionId}`),
        config.retry.api,
        'Polymarket getMarket'
      );

      return this.transformMarket(response.data);
    } catch (error) {
      if ((error as AxiosError).response?.status === 404) {
        return null;
      }
      logger.error('Failed to get market', {
        conditionId,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  private transformMarket(apiMarket: PolymarketApiMarket): PolymarketMarket {
    // Find YES and NO token IDs
    const yesToken = apiMarket.tokens.find(t => t.outcome.toLowerCase() === 'yes');
    const noToken = apiMarket.tokens.find(t => t.outcome.toLowerCase() === 'no');

    return {
      id: apiMarket.condition_id,
      conditionId: apiMarket.condition_id,
      questionId: apiMarket.question_id,
      title: apiMarket.question,
      description: apiMarket.description,
      outcomes: apiMarket.outcomes,
      outcomePrices: apiMarket.outcome_prices.map(p => parseFloat(p)),
      tokens: {
        yes: yesToken?.token_id || '',
        no: noToken?.token_id || '',
      },
      endDate: new Date(apiMarket.end_date_iso),
      volume: parseFloat(apiMarket.volume),
      liquidity: parseFloat(apiMarket.liquidity),
    };
  }

  async getOrderBook(tokenId: string): Promise<OrderBook> {
    const config = getConfig();

    try {
      await this.rateLimiter.waitForSlot();

      const startTime = Date.now();
      const response = await withRetry(
        () => this.client.get<PolymarketOrderBookResponse>('/book', {
          params: { token_id: tokenId },
        }),
        config.retry.api,
        'Polymarket getOrderBook'
      );

      const latency = Date.now() - startTime;
      if (latency > config.latency.orderbookFetchTargetMs) {
        logger.warn('Orderbook fetch latency exceeded target', {
          latency,
          target: config.latency.orderbookFetchTargetMs,
        });
      }

      return {
        bids: response.data.bids.map(b => ({
          price: parseFloat(b.price),
          size: parseFloat(b.size),
        })),
        asks: response.data.asks.map(a => ({
          price: parseFloat(a.price),
          size: parseFloat(a.size),
        })),
        timestamp: new Date(response.data.timestamp),
      };
    } catch (error) {
      logger.error('Failed to get order book', {
        tokenId,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  async placeLimitOrder(order: LimitOrder): Promise<OrderResult> {
    if (!this.wallet) {
      return {
        success: false,
        orderId: '',
        timestamp: new Date(),
        error: 'Wallet not initialized',
      };
    }

    const config = getConfig();

    try {
      await this.orderRateLimiter.waitForSlot();

      // Prepare order parameters
      const params: CreateOrderParams = {
        tokenId: order.marketId,
        side: order.side === 'buy' ? 'BUY' : 'SELL',
        price: order.price,
        size: order.quantity,
        orderType: order.orderType,
      };

      // Generate order signature
      const nonce = generateNonce();
      const expiration = order.orderType === 'FOK' ? getExpiration(60) : getExpiration(3600);
      const walletAddress = await this.wallet.getAddress();

      const signature = await signOrder(this.wallet, {
        tokenId: params.tokenId,
        price: params.price.toString(),
        size: params.size.toString(),
        side: params.side,
        nonce,
        expiration,
        maker: walletAddress,
        taker: '0x0000000000000000000000000000000000000000',
        feeRateBps: '0',
      });

      // Submit order
      const startTime = Date.now();
      const response = await this.client.post('/order', {
        tokenID: params.tokenId,
        price: params.price.toString(),
        size: params.size.toString(),
        side: params.side,
        orderType: params.orderType,
        nonce,
        expiration,
        signature,
        signatureType: 0,
      });

      const latency = Date.now() - startTime;
      if (latency > config.latency.orderPlacementMaxMs) {
        logger.error('Order placement latency exceeded maximum', {
          latency,
          max: config.latency.orderPlacementMaxMs,
        });
      }

      const orderResult = response.data;

      // For FOK orders, check if it was filled
      if (order.orderType === 'FOK') {
        if (orderResult.status === 'MATCHED') {
          const fill = orderResult.fills?.[0];
          return {
            success: true,
            orderId: orderResult.orderID,
            fillPrice: fill ? parseFloat(fill.price) : order.price,
            fillQuantity: fill ? parseFloat(fill.size) : order.quantity,
            fees: fill ? parseFloat(fill.fee) : 0,
            timestamp: new Date(orderResult.transactTime),
          };
        } else {
          // FOK order was not filled - this is expected behavior
          return {
            success: false,
            orderId: orderResult.orderID || '',
            timestamp: new Date(),
            error: 'FOK order not filled',
          };
        }
      }

      return {
        success: true,
        orderId: orderResult.orderID,
        timestamp: new Date(orderResult.transactTime),
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
      await this.orderRateLimiter.waitForSlot();
      await this.client.delete(`/order/${orderId}`);
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
    if (!this.wallet) {
      return {
        platform: 'polymarket',
        available: 0,
        locked: 0,
        total: 0,
        currency: 'USDC',
      };
    }

    try {
      await this.rateLimiter.waitForSlot();

      const walletAddress = await this.wallet.getAddress();
      const response = await this.client.get(`/balance/${walletAddress}`);

      const balance = parseFloat(response.data.balance || '0') / 1e6; // USDC has 6 decimals
      const allowance = parseFloat(response.data.allowance || '0') / 1e6;

      return {
        platform: 'polymarket',
        available: Math.min(balance, allowance),
        locked: 0, // Would need to calculate from open orders
        total: balance,
        currency: 'USDC',
      };
    } catch (error) {
      logger.error('Failed to get balances', { error: (error as Error).message });
      return {
        platform: 'polymarket',
        available: 0,
        locked: 0,
        total: 0,
        currency: 'USDC',
      };
    }
  }

  async getPositions(): Promise<Position[]> {
    if (!this.wallet) {
      return [];
    }

    try {
      await this.rateLimiter.waitForSlot();

      const walletAddress = await this.wallet.getAddress();
      const response = await this.client.get<PolymarketPositionResponse[]>(
        `/positions/${walletAddress}`
      );

      return response.data.map(pos => ({
        id: generateId(),
        platform: 'polymarket' as Platform,
        eventId: pos.market,
        side: pos.outcome.toLowerCase() as 'yes' | 'no',
        quantity: parseFloat(pos.size),
        avgPrice: parseFloat(pos.avg_price),
        currentPrice: parseFloat(pos.cur_price),
        unrealizedPnL: parseFloat(pos.unrealized_pnl),
        openedAt: new Date(),
        updatedAt: new Date(),
      }));
    } catch (error) {
      logger.error('Failed to get positions', { error: (error as Error).message });
      return [];
    }
  }
}

// Export singleton instance
let instance: PolymarketConnector | null = null;

export function getPolymarketConnector(): PolymarketConnector {
  if (!instance) {
    instance = new PolymarketConnector();
  }
  return instance;
}
