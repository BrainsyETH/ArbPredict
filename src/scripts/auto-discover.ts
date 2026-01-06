import axios from 'axios';
import { getKalshiConnector } from '../connectors/kalshi/index.js';
import { getEventMatcher } from '../core/event-matcher.js';
import { testConnection, closePool } from '../db/index.js';
import { createChildLogger } from '../utils/logger.js';
import type { PolymarketMarket, KalshiMarket } from '../types/index.js';

const logger = createChildLogger('auto-discover');

interface PolymarketApiMarket {
  condition_id: string;
  question: string;
  description: string;
  end_date_iso: string;
  active: boolean;
  closed: boolean;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
  }>;
}

/**
 * Fetch markets from Polymarket API
 */
async function fetchPolymarketMarkets(category?: string): Promise<PolymarketMarket[]> {
  try {
    const response = await axios.get<PolymarketApiMarket[]>(
      'https://clob.polymarket.com/markets',
      {
        params: {
          limit: 100,
          active: true,
        },
        timeout: 30000,
      }
    );

    const markets: PolymarketMarket[] = response.data
      .filter(m => m.active && !m.closed)
      .filter(m => {
        if (!category) return true;
        const text = `${m.question} ${m.description}`.toLowerCase();
        return text.includes(category.toLowerCase());
      })
      .map(m => {
        const yesToken = m.tokens?.find(t => t.outcome === 'Yes');
        const noToken = m.tokens?.find(t => t.outcome === 'No');

        return {
          id: m.condition_id,
          conditionId: m.condition_id,
          questionId: m.condition_id,
          title: m.question,
          description: m.description || '',
          outcomes: ['Yes', 'No'],
          outcomePrices: [yesToken?.price || 0, noToken?.price || 0],
          tokens: {
            yes: yesToken?.token_id || '',
            no: noToken?.token_id || '',
          },
          yesPrice: yesToken?.price || 0,
          noPrice: noToken?.price || 0,
          volume: 0,
          liquidity: 0,
          endDate: new Date(m.end_date_iso),
          category: category || 'unknown',
        };
      });

    logger.info(`Fetched ${markets.length} Polymarket markets`);
    return markets;
  } catch (error) {
    logger.error(`Failed to fetch Polymarket markets: ${(error as Error).message}`);
    return [];
  }
}

/**
 * Fetch markets from Kalshi API
 */
async function fetchKalshiMarkets(category?: string): Promise<KalshiMarket[]> {
  try {
    const connector = getKalshiConnector();

    // Connect if not already connected
    if (!connector.isConnected()) {
      const connected = await connector.connect();
      if (!connected) {
        logger.error('Failed to connect to Kalshi');
        return [];
      }
    }

    const markets = await connector.getMarkets('open');

    // Filter by category if specified
    const filtered = category
      ? markets.filter(m => {
          const text = `${m.title} ${m.category}`.toLowerCase();
          return text.includes(category.toLowerCase());
        })
      : markets;

    logger.info(`Fetched ${filtered.length} Kalshi markets`);
    return filtered;
  } catch (error) {
    logger.error(`Failed to fetch Kalshi markets: ${(error as Error).message}`);
    return [];
  }
}

/**
 * Auto-discover and create mappings between platforms
 */
export async function autoDiscoverMappings(options: {
  category?: string;
  dryRun?: boolean;
}): Promise<{ found: number; added: number }> {
  const { category, dryRun = false } = options;

  logger.info('Starting auto-discovery...', { category, dryRun });

  // Test database connection
  const dbConnected = await testConnection();
  if (!dbConnected) {
    logger.error('Database connection failed');
    return { found: 0, added: 0 };
  }

  // Fetch markets from both platforms
  const [polymarketMarkets, kalshiMarkets] = await Promise.all([
    fetchPolymarketMarkets(category),
    fetchKalshiMarkets(category),
  ]);

  if (polymarketMarkets.length === 0 || kalshiMarkets.length === 0) {
    logger.warn('No markets found on one or both platforms');
    return { found: 0, added: 0 };
  }

  logger.info(`Comparing ${polymarketMarkets.length} Polymarket markets with ${kalshiMarkets.length} Kalshi markets`);

  // Use event matcher to find matches
  const eventMatcher = getEventMatcher();
  await eventMatcher.loadMappings();

  let found = 0;
  let added = 0;

  for (const polymarket of polymarketMarkets) {
    // Check if already mapped
    const existingMapping = eventMatcher.getMapping(polymarket.conditionId);
    if (existingMapping) {
      logger.debug(`Already mapped: ${polymarket.title.substring(0, 50)}...`);
      continue;
    }

    // Try to find a Kalshi match
    const mapping = await eventMatcher.findKalshiEquivalent(polymarket, kalshiMarkets);

    if (mapping) {
      found++;

      if (!dryRun) {
        added++;
        logger.info(`✓ Matched: "${polymarket.title.substring(0, 40)}..." → ${mapping.kalshiTicker} (${(mapping.matchConfidence * 100).toFixed(1)}% confidence)`);
      } else {
        logger.info(`[DRY RUN] Would match: "${polymarket.title.substring(0, 40)}..." → ${mapping.kalshiTicker} (${(mapping.matchConfidence * 100).toFixed(1)}% confidence)`);
      }
    }
  }

  logger.info(`Auto-discovery complete: ${found} matches found, ${added} added`);
  return { found, added };
}

/**
 * List available categories from both platforms
 */
export async function listCategories(): Promise<void> {
  logger.info('Fetching categories from both platforms...');

  const kalshiMarkets = await fetchKalshiMarkets();

  // Extract unique categories from Kalshi
  const kalshiCategories = new Set<string>();
  for (const market of kalshiMarkets) {
    if (market.category) {
      kalshiCategories.add(market.category);
    }
  }

  console.log('\nKalshi Categories:');
  for (const cat of kalshiCategories) {
    console.log(`  - ${cat}`);
  }

  console.log('\nSuggested search terms for crypto:');
  console.log('  - bitcoin, btc');
  console.log('  - ethereum, eth');
  console.log('  - crypto');
}

// Run if called directly
if (process.argv[1]?.includes('auto-discover')) {
  const category = process.argv[2] || undefined;
  const dryRun = process.argv.includes('--dry-run');

  autoDiscoverMappings({ category, dryRun })
    .then(result => {
      console.log(`\nResults: ${result.found} found, ${result.added} added`);
      return closePool();
    })
    .catch(error => {
      console.error('Auto-discovery failed:', error);
      process.exit(1);
    });
}
