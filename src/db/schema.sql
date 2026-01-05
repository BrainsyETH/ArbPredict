-- Polymarket-Kalshi Arbitrage Bot Database Schema
-- Version: 1.0.0

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Event mappings between Polymarket and Kalshi
CREATE TABLE IF NOT EXISTS event_mappings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  polymarket_condition_id VARCHAR(66) NOT NULL,
  kalshi_ticker VARCHAR(50) NOT NULL,
  description TEXT,
  match_confidence DECIMAL(3,2) NOT NULL CHECK (match_confidence >= 0 AND match_confidence <= 1),
  match_method VARCHAR(20) NOT NULL CHECK (match_method IN ('exact', 'fuzzy', 'manual')),
  resolution_date TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE,
  UNIQUE(polymarket_condition_id, kalshi_ticker)
);

-- Outcome mappings for each event
CREATE TABLE IF NOT EXISTS outcome_mappings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_mapping_id UUID NOT NULL REFERENCES event_mappings(id) ON DELETE CASCADE,
  polymarket_outcome VARCHAR(100) NOT NULL,
  kalshi_side VARCHAR(10) NOT NULL CHECK (kalshi_side IN ('yes', 'no')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Detected arbitrage opportunities
CREATE TABLE IF NOT EXISTS opportunities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_mapping_id UUID REFERENCES event_mappings(id),
  detected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  buy_platform VARCHAR(20) NOT NULL CHECK (buy_platform IN ('polymarket', 'kalshi')),
  buy_price DECIMAL(10,6) NOT NULL,
  buy_quantity DECIMAL(18,6) NOT NULL,
  sell_platform VARCHAR(20) NOT NULL CHECK (sell_platform IN ('polymarket', 'kalshi')),
  sell_price DECIMAL(10,6) NOT NULL,
  sell_quantity DECIMAL(18,6) NOT NULL,
  gross_spread DECIMAL(10,6) NOT NULL,
  estimated_fees DECIMAL(10,6) NOT NULL,
  net_profit DECIMAL(10,6) NOT NULL,
  was_executed BOOLEAN DEFAULT FALSE,
  expired_at TIMESTAMP WITH TIME ZONE,
  execution_risk DECIMAL(3,2)
);

-- Trade executions
CREATE TABLE IF NOT EXISTS executions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  opportunity_id UUID REFERENCES opportunities(id),
  executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'partial', 'complete', 'failed')),

  -- Buy leg
  buy_order_id VARCHAR(100),
  buy_fill_price DECIMAL(10,6),
  buy_fill_quantity DECIMAL(18,6),
  buy_fees DECIMAL(10,6),
  buy_platform VARCHAR(20) NOT NULL,

  -- Sell leg
  sell_order_id VARCHAR(100),
  sell_fill_price DECIMAL(10,6),
  sell_fill_quantity DECIMAL(18,6),
  sell_fees DECIMAL(10,6),
  sell_platform VARCHAR(20) NOT NULL,

  -- Results
  actual_profit DECIMAL(10,6),
  slippage DECIMAL(10,6),
  notes TEXT,

  -- Dry run flag
  is_dry_run BOOLEAN DEFAULT FALSE
);

-- Open positions
CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  platform VARCHAR(20) NOT NULL CHECK (platform IN ('polymarket', 'kalshi')),
  event_id VARCHAR(100) NOT NULL,
  event_mapping_id UUID REFERENCES event_mappings(id),
  side VARCHAR(10) NOT NULL CHECK (side IN ('yes', 'no')),
  quantity DECIMAL(18,6) NOT NULL,
  avg_price DECIMAL(10,6) NOT NULL,
  current_price DECIMAL(10,6),
  unrealized_pnl DECIMAL(10,6),
  opened_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  closed_at TIMESTAMP WITH TIME ZONE,
  is_open BOOLEAN DEFAULT TRUE
);

-- Daily P&L records
CREATE TABLE IF NOT EXISTS pnl_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  date DATE NOT NULL,
  platform VARCHAR(20),
  realized_pnl DECIMAL(12,6) DEFAULT 0,
  unrealized_pnl DECIMAL(12,6) DEFAULT 0,
  fees_paid DECIMAL(12,6) DEFAULT 0,
  volume_traded DECIMAL(18,6) DEFAULT 0,
  num_trades INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(date, platform)
);

-- Circuit breaker events log
CREATE TABLE IF NOT EXISTS circuit_breaker_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type VARCHAR(50) NOT NULL,
  reason TEXT NOT NULL,
  triggered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  resumed_at TIMESTAMP WITH TIME ZONE,
  notes TEXT
);

-- API rate limit tracking
CREATE TABLE IF NOT EXISTS rate_limit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  platform VARCHAR(20) NOT NULL,
  endpoint VARCHAR(100) NOT NULL,
  request_count INTEGER DEFAULT 1,
  window_start TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  was_throttled BOOLEAN DEFAULT FALSE
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_opportunities_detected_at ON opportunities(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_opportunities_event_mapping ON opportunities(event_mapping_id);
CREATE INDEX IF NOT EXISTS idx_executions_executed_at ON executions(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);
CREATE INDEX IF NOT EXISTS idx_positions_platform ON positions(platform);
CREATE INDEX IF NOT EXISTS idx_positions_open ON positions(is_open) WHERE is_open = TRUE;
CREATE INDEX IF NOT EXISTS idx_pnl_records_date ON pnl_records(date DESC);
CREATE INDEX IF NOT EXISTS idx_event_mappings_active ON event_mappings(is_active) WHERE is_active = TRUE;

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
DROP TRIGGER IF EXISTS update_event_mappings_updated_at ON event_mappings;
CREATE TRIGGER update_event_mappings_updated_at
    BEFORE UPDATE ON event_mappings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_positions_updated_at ON positions;
CREATE TRIGGER update_positions_updated_at
    BEFORE UPDATE ON positions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
