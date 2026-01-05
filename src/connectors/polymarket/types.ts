// Polymarket-specific types

export interface PolymarketApiMarket {
  condition_id: string;
  question_id: string;
  question: string;
  description: string;
  outcomes: string[];
  outcome_prices: string[];
  tokens: {
    token_id: string;
    outcome: string;
  }[];
  end_date_iso: string;
  active: boolean;
  closed: boolean;
  volume: string;
  liquidity: string;
  slug: string;
}

export interface PolymarketOrderBookResponse {
  market: string;
  asset_id: string;
  timestamp: string;
  bids: PolymarketOrderBookLevel[];
  asks: PolymarketOrderBookLevel[];
}

export interface PolymarketOrderBookLevel {
  price: string;
  size: string;
}

export interface PolymarketOrderRequest {
  tokenID: string;
  price: string;
  size: string;
  side: 'BUY' | 'SELL';
  feeRateBps: string;
  nonce: string;
  expiration: string;
  taker: string;
  maker: string;
  signatureType: number;
  signature: string;
}

export interface PolymarketOrderResponse {
  orderID: string;
  status: 'LIVE' | 'MATCHED' | 'CANCELED' | 'EXPIRED';
  transactTime: string;
  takingAmount: string;
  makingAmount: string;
  fills?: PolymarketFill[];
}

export interface PolymarketFill {
  matchID: string;
  price: string;
  size: string;
  side: string;
  fee: string;
  timestamp: string;
}

export interface PolymarketBalanceResponse {
  allowance: string;
  balance: string;
}

export interface PolymarketPositionResponse {
  asset_id: string;
  market: string;
  outcome: string;
  size: string;
  avg_price: string;
  cur_price: string;
  realized_pnl: string;
  unrealized_pnl: string;
}

export interface PolymarketWebSocketMessage {
  type: string;
  channel?: string;
  assets_ids?: string[];
  market?: string;
  data?: unknown;
}

export interface PolymarketBookUpdateMessage {
  event_type: 'book';
  asset_id: string;
  timestamp: string;
  bids: PolymarketOrderBookLevel[];
  asks: PolymarketOrderBookLevel[];
}

export interface PolymarketTradeMessage {
  event_type: 'trade';
  asset_id: string;
  price: string;
  size: string;
  side: string;
  timestamp: string;
}

// API response wrapper
export interface PolymarketApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
}

// Order creation parameters
export interface CreateOrderParams {
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  orderType: 'FOK' | 'GTC' | 'GTD';
  expirationTs?: number;
}
