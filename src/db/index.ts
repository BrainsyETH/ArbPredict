import { Pool, type PoolClient, type QueryResult } from 'pg';
import { getConfig } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('database');

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const config = getConfig();

    pool = new Pool({
      host: config.database.host,
      port: config.database.port,
      database: config.database.name,
      user: config.database.user,
      password: config.database.password,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    pool.on('error', (err) => {
      logger.error('Unexpected database pool error', { error: err.message });
    });

    logger.info('Database pool created', {
      host: config.database.host,
      database: config.database.name,
    });
  }

  return pool;
}

export async function query<T = unknown>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  const result = await getPool().query<T>(text, params);
  const duration = Date.now() - start;

  logger.debug('Query executed', {
    text: text.substring(0, 100),
    duration,
    rows: result.rowCount,
  });

  return result;
}

export async function getClient(): Promise<PoolClient> {
  const client = await getPool().connect();
  return client;
}

export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function testConnection(): Promise<boolean> {
  try {
    const result = await query('SELECT NOW() as now');
    logger.info('Database connection successful', { serverTime: result.rows[0] });
    return true;
  } catch (error) {
    logger.error('Database connection failed', { error: (error as Error).message });
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database pool closed');
  }
}

// Repository helpers
export interface EventMappingRow {
  id: string;
  polymarket_condition_id: string;
  kalshi_ticker: string;
  description: string | null;
  match_confidence: string;
  match_method: string;
  resolution_date: Date | null;
  created_at: Date;
  updated_at: Date;
  is_active: boolean;
}

export interface OpportunityRow {
  id: string;
  event_mapping_id: string | null;
  detected_at: Date;
  buy_platform: string;
  buy_price: string;
  buy_quantity: string;
  sell_platform: string;
  sell_price: string;
  sell_quantity: string;
  gross_spread: string;
  estimated_fees: string;
  net_profit: string;
  was_executed: boolean;
  expired_at: Date | null;
}

export interface ExecutionRow {
  id: string;
  opportunity_id: string | null;
  executed_at: Date;
  status: string;
  buy_order_id: string | null;
  buy_fill_price: string | null;
  buy_fill_quantity: string | null;
  buy_fees: string | null;
  buy_platform: string;
  sell_order_id: string | null;
  sell_fill_price: string | null;
  sell_fill_quantity: string | null;
  sell_fees: string | null;
  sell_platform: string;
  actual_profit: string | null;
  slippage: string | null;
  notes: string | null;
  is_dry_run: boolean;
}

export interface PositionRow {
  id: string;
  platform: string;
  event_id: string;
  event_mapping_id: string | null;
  side: string;
  quantity: string;
  avg_price: string;
  current_price: string | null;
  unrealized_pnl: string | null;
  opened_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  is_open: boolean;
}
