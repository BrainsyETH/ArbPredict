import { query, testConnection, closePool } from './index.js';
import { createChildLogger } from '../utils/logger.js';
import { generateId } from '../utils/helpers.js';

const logger = createChildLogger('seed');

// Sample event mappings for testing
// These are example mappings - in production, real condition IDs and tickers would be used
const SAMPLE_MAPPINGS = [
  {
    polymarket_condition_id: '0x1234567890abcdef1234567890abcdef12345678',
    kalshi_ticker: 'PRES-2024-DEM',
    description: 'Will a Democrat win the 2024 Presidential Election?',
    match_confidence: 1.0,
    match_method: 'manual',
    resolution_date: '2024-11-05',
  },
  {
    polymarket_condition_id: '0xabcdef1234567890abcdef1234567890abcdef12',
    kalshi_ticker: 'BTC-100K-DEC25',
    description: 'Will Bitcoin reach $100,000 by December 2025?',
    match_confidence: 1.0,
    match_method: 'manual',
    resolution_date: '2025-12-31',
  },
  {
    polymarket_condition_id: '0x9876543210fedcba9876543210fedcba98765432',
    kalshi_ticker: 'FED-RATE-Q1-25',
    description: 'Will the Fed raise rates in Q1 2025?',
    match_confidence: 1.0,
    match_method: 'manual',
    resolution_date: '2025-03-31',
  },
];

async function seedDatabase(): Promise<void> {
  logger.info('Starting database seed...');

  // Test connection
  const connected = await testConnection();
  if (!connected) {
    logger.error('Cannot connect to database');
    process.exit(1);
  }

  try {
    // Insert sample mappings
    for (const mapping of SAMPLE_MAPPINGS) {
      const id = generateId();

      await query(
        `INSERT INTO event_mappings
         (id, polymarket_condition_id, kalshi_ticker, description, match_confidence, match_method, resolution_date, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)
         ON CONFLICT (polymarket_condition_id, kalshi_ticker) DO NOTHING`,
        [
          id,
          mapping.polymarket_condition_id,
          mapping.kalshi_ticker,
          mapping.description,
          mapping.match_confidence,
          mapping.match_method,
          new Date(mapping.resolution_date),
        ]
      );

      logger.info(`Inserted mapping: ${mapping.kalshi_ticker}`);
    }

    // Insert outcome mappings for each event
    const mappingsResult = await query<{ id: string }>(
      'SELECT id FROM event_mappings WHERE is_active = true'
    );

    for (const row of mappingsResult.rows) {
      // Add YES/NO outcome mappings
      await query(
        `INSERT INTO outcome_mappings (id, event_mapping_id, polymarket_outcome, kalshi_side)
         VALUES ($1, $2, 'Yes', 'yes'), ($3, $2, 'No', 'no')
         ON CONFLICT DO NOTHING`,
        [generateId(), row.id, generateId()]
      );
    }

    logger.info('Database seeded successfully');
    logger.info(`Inserted ${SAMPLE_MAPPINGS.length} sample event mappings`);
  } catch (error) {
    logger.error(`Seed failed: ${(error as Error).message}`);
    console.error('Full error:', error);
    process.exit(1);
  } finally {
    await closePool();
  }
}

// Run if called directly
seedDatabase();
