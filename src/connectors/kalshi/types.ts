// Kalshi-specific types

export interface KalshiLoginRequest {
  email: string;
  password: string;
}

export interface KalshiLoginResponse {
  token: string;
  member_id: string;
}

export interface KalshiApiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle: string;
  category: string;
  status: 'open' | 'closed' | 'settled';
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  volume_24h: number;
  open_interest: number;
  expiration_time: string;
  close_time: string;
  result?: 'yes' | 'no';
}

export interface KalshiOrderBookResponse {
  orderbook: {
    yes: KalshiOrderBookLevel[];
    no: KalshiOrderBookLevel[];
  };
  ticker: string;
}

export interface KalshiOrderBookLevel {
  price: number;  // in cents (1-99)
  quantity: number;
}

export interface KalshiOrderRequest {
  ticker: string;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  type: 'limit' | 'market';
  count: number;
  yes_price?: number;  // in cents
  no_price?: number;   // in cents
  expiration_ts?: number;
  client_order_id?: string;
  // FOK support
  time_in_force?: 'gtc' | 'ioc' | 'fok';
}

export interface KalshiOrderResponse {
  order_id: string;
  ticker: string;
  status: 'pending' | 'open' | 'executed' | 'canceled' | 'expired';
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  type: 'limit' | 'market';
  count: number;
  remaining_count: number;
  yes_price?: number;
  no_price?: number;
  created_time: string;
  expiration_time?: string;
  taker_fill_cost?: number;
  taker_fill_count?: number;
  maker_fill_cost?: number;
  maker_fill_count?: number;
  taker_fees?: number;
}

export interface KalshiFill {
  trade_id: string;
  order_id: string;
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  count: number;
  yes_price: number;
  no_price: number;
  is_taker: boolean;
  created_time: string;
}

export interface KalshiBalanceResponse {
  balance: number;  // in cents
}

export interface KalshiPositionResponse {
  ticker: string;
  event_ticker: string;
  market_result?: 'yes' | 'no';
  position: number;  // positive = yes, negative = no
  total_cost: number;  // in cents
  realized_pnl: number;
}

export interface KalshiMarketsResponse {
  markets: KalshiApiMarket[];
  cursor?: string;
}

export interface KalshiPositionsResponse {
  market_positions: KalshiPositionResponse[];
  cursor?: string;
}

// WebSocket types
export interface KalshiWebSocketMessage {
  id?: number;
  type: string;
  msg?: unknown;
  sid?: number;
}

export interface KalshiWebSocketSubscribe {
  id: number;
  cmd: 'subscribe';
  params: {
    channels: string[];
    market_tickers?: string[];
  };
}

export interface KalshiOrderBookUpdate {
  type: 'orderbook_delta' | 'orderbook_snapshot';
  msg: {
    market_ticker: string;
    yes: KalshiOrderBookLevel[];
    no: KalshiOrderBookLevel[];
    seq: number;
  };
}

export interface KalshiTradeUpdate {
  type: 'trade';
  msg: {
    market_ticker: string;
    yes_price: number;
    no_price: number;
    count: number;
    taker_side: 'yes' | 'no';
    ts: number;
  };
}

// API response wrapper
export interface KalshiApiResponse<T> {
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

// Cursor-based pagination
export interface PaginationParams {
  cursor?: string;
  limit?: number;
}
