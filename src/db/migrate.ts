import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getPool, closePool, testConnection } from './index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('migrate');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigration(): Promise<void> {
  logger.info('Starting database migration...');

  // Test connection first
  const connected = await testConnection();
  if (!connected) {
    logger.error('Cannot connect to database. Please check your configuration.');
    process.exit(1);
  }

  try {
    // Read schema file
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');

    // Execute schema
    const pool = getPool();
    await pool.query(schema);

    logger.info('Database migration completed successfully');
  } catch (error) {
    logger.error('Migration failed', { error: (error as Error).message });
    process.exit(1);
  } finally {
    await closePool();
  }
}

// Run if called directly
runMigration();
