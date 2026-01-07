import axios from 'axios';
import { getKalshiConnector } from '../connectors/kalshi/index.js';
import { getEventMatcher } from '../core/event-matcher.js';
import { testConnection, closePool } from '../db/index.js';
import { createChildLogger } from '../utils/logger.js';
import { normalize, levenshteinSimilarity } from '../utils/helpers.js';
import type { PolymarketMarket, KalshiMarket } from '../types/index.js';

const logger = createChildLogger('auto-discover');

interface PolymarketApiMarket {
  condition_id: string;
  question: string;
  question_id?: string;
  description?: string;
  end_date_iso?: string;
  game_start_time?: string;
  active: boolean;
  closed: boolean;
  tokens?: Array<{
    token_id: string;
    outcome: string;
    price?: number;
  }>;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string[];
}

interface PolymarketApiResponse {
  // CLOB API returns array directly or with next_cursor
  data?: PolymarketApiMarket[];
  markets?: PolymarketApiMarket[];
  next_cursor?: string;
}

/**
 * Fetch markets from Polymarket API
 * Tries both CLOB and Gamma APIs
 */
async function fetchPolymarketMarkets(category?: string): Promise<PolymarketMarket[]> {
  try {
    logger.info('Fetching Polymarket markets...');

    // Try the Gamma Markets API first (more data)
    const response = await axios.get<PolymarketApiResponse | PolymarketApiMarket[]>(
      'https://gamma-api.polymarket.com/markets',
      {
        params: {
          limit: 100,
          active: true,
          closed: false,
        },
        timeout: 30000,
      }
    );

    logger.debug(`Gamma API response type: ${typeof response.data}, isArray: ${Array.isArray(response.data)}`);

    // Handle different response structures
    let rawMarkets: PolymarketApiMarket[];

    if (Array.isArray(response.data)) {
      rawMarkets = response.data;
      logger.debug(`Response is array with ${rawMarkets.length} items`);
    } else if (response.data && typeof response.data === 'object') {
      // Log the keys to see structure
      logger.debug(`Response keys: ${Object.keys(response.data).join(', ')}`);

      if ('data' in response.data && Array.isArray(response.data.data)) {
        rawMarkets = response.data.data;
      } else if ('markets' in response.data && Array.isArray(response.data.markets)) {
        rawMarkets = response.data.markets;
      } else {
        // Try to extract any array from the response
        const possibleArrays = Object.values(response.data).filter(v => Array.isArray(v));
        if (possibleArrays.length > 0) {
          rawMarkets = possibleArrays[0] as PolymarketApiMarket[];
          logger.debug(`Found array in response with ${rawMarkets.length} items`);
        } else {
          logger.warn('Could not find markets array in Gamma API response');
          rawMarkets = [];
        }
      }
    } else {
      logger.warn(`Unexpected Gamma API response type: ${typeof response.data}`);
      rawMarkets = [];
    }

    logger.info(`Gamma API returned ${rawMarkets.length} raw markets`);

    // Log first market for debugging
    if (rawMarkets.length > 0) {
      const sample = rawMarkets[0];
      logger.debug(`Sample market keys: ${Object.keys(sample).join(', ')}`);
      logger.debug(`Sample market: question="${sample.question}", active=${sample.active}, closed=${sample.closed}`);
    }

    // Filter markets - be lenient with active/closed if fields don't exist
    const activeMarkets = rawMarkets.filter(m => {
      // If active field exists, check it; otherwise assume active
      const isActive = m.active === undefined ? true : m.active;
      // If closed field exists, check it; otherwise assume not closed
      const isClosed = m.closed === undefined ? false : m.closed;
      return isActive && !isClosed;
    });

    logger.debug(`After active/closed filter: ${activeMarkets.length} markets`);

    // Filter by category
    const filteredMarkets = activeMarkets.filter(m => {
      if (!category) return true;
      const text = `${m.question || ''} ${m.description || ''}`.toLowerCase();
      const matches = text.includes(category.toLowerCase());
      if (!matches && activeMarkets.length <= 10) {
        logger.debug(`Market "${m.question?.substring(0, 50)}..." does not match "${category}"`);
      }
      return matches;
    });

    logger.debug(`After category filter "${category}": ${filteredMarkets.length} markets`);

    const markets: PolymarketMarket[] = filteredMarkets.map(m => {
        // Handle different token formats
        let yesPrice = 0;
        let noPrice = 0;
        let yesTokenId = '';
        let noTokenId = '';

        if (m.tokens && m.tokens.length > 0) {
          const yesToken = m.tokens.find(t => t.outcome === 'Yes');
          const noToken = m.tokens.find(t => t.outcome === 'No');
          yesPrice = yesToken?.price || 0;
          noPrice = noToken?.price || 0;
          yesTokenId = yesToken?.token_id || '';
          noTokenId = noToken?.token_id || '';
        } else if (m.outcomePrices) {
          try {
            const prices = JSON.parse(m.outcomePrices);
            yesPrice = parseFloat(prices[0]) || 0;
            noPrice = parseFloat(prices[1]) || 0;
          } catch { /* ignore parse errors */ }
        }

        if (m.clobTokenIds && m.clobTokenIds.length >= 2) {
          yesTokenId = m.clobTokenIds[0];
          noTokenId = m.clobTokenIds[1];
        }

        const endDate = m.end_date_iso || m.game_start_time;

        return {
          id: m.condition_id,
          conditionId: m.condition_id,
          questionId: m.question_id || m.condition_id,
          title: m.question,
          description: m.description || '',
          outcomes: ['Yes', 'No'],
          outcomePrices: [yesPrice, noPrice],
          tokens: {
            yes: yesTokenId,
            no: noTokenId,
          },
          yesPrice,
          noPrice,
          volume: 0,
          liquidity: 0,
          endDate: endDate ? new Date(endDate) : new Date(),
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
 * Simple matching function for dry-run mode (no database required)
 * Uses a lower threshold than production to find potential matches
 */
function findMatchDryRun(
  polymarket: PolymarketMarket,
  kalshiMarkets: KalshiMarket[],
  minSimilarity: number = 0.5  // Lower threshold for discovery
): { kalshiTicker: string; confidence: number; kalshiTitle: string } | null {
  const normalizedPolyTitle = normalize(polymarket.title);

  let bestMatch: { kalshiTicker: string; confidence: number; kalshiTitle: string } | null = null;
  let bestSimilarity = 0;

  for (const kalshi of kalshiMarkets) {
    const normalizedKalshiTitle = normalize(kalshi.title);

    // Exact match
    if (normalizedPolyTitle === normalizedKalshiTitle) {
      return { kalshiTicker: kalshi.ticker, confidence: 1.0, kalshiTitle: kalshi.title };
    }

    // Fuzzy match - track best match
    const similarity = levenshteinSimilarity(normalizedPolyTitle, normalizedKalshiTitle);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatch = { kalshiTicker: kalshi.ticker, confidence: similarity, kalshiTitle: kalshi.title };
    }
  }

  // Return best match if above threshold
  if (bestMatch && bestSimilarity >= minSimilarity) {
    return bestMatch;
  }

  return null;
}

// Kalshi categories that likely overlap with Polymarket
const KALSHI_POLITICAL_CATEGORIES = ['Politics', 'Elections', 'Economics', 'Climate and Weather', 'Health', 'World'];

/**
 * Fetch markets from Kalshi API, focusing on political/news categories
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

    // Get events first to find relevant event tickers
    logger.info('Fetching Kalshi events to find political markets...');
    const events = await connector.getEvents();

    // Filter events by political categories
    const relevantEvents = events.filter(e =>
      KALSHI_POLITICAL_CATEGORIES.includes(e.category)
    );
    logger.info(`Found ${relevantEvents.length} events in political categories`);

    // Get markets - fetch more since we're filtering
    logger.info('Fetching Kalshi markets...');
    const allMarkets = await connector.getMarkets('open', 1000);
    logger.info(`Kalshi returned ${allMarkets.length} total markets`);

    // Debug: Log sample market and event structure
    if (allMarkets.length > 0) {
      const sample = allMarkets[0];
      logger.debug(`Sample market keys: ${Object.keys(sample).join(', ')}`);
      logger.debug(`Sample market: ticker=${sample.ticker}, category=${sample.category}, title=${sample.title?.substring(0, 50)}`);
    }
    if (relevantEvents.length > 0) {
      logger.debug(`Sample event ticker: ${relevantEvents[0].event_ticker}`);
    }

    // Filter markets to only those from political events
    const relevantEventTickers = new Set(relevantEvents.map(e => e.event_ticker));
    logger.debug(`Looking for event tickers like: ${Array.from(relevantEventTickers).slice(0, 5).join(', ')}`);

    // Log sample market's eventTicker for debugging
    if (allMarkets.length > 0) {
      logger.debug(`Sample market eventTicker: "${allMarkets[0].eventTicker}", ticker: "${allMarkets[0].ticker}"`);
    }

    let filtered = allMarkets.filter(m => {
      // Check if market's eventTicker matches one of the political events
      return relevantEventTickers.has(m.eventTicker);
    });

    logger.debug(`Filtered to ${filtered.length} markets by eventTicker`);

    // If no matches by event ticker, try category-based filtering
    if (filtered.length === 0) {
      logger.info('No event ticker matches, trying category-based filtering...');
      filtered = allMarkets.filter(m =>
        KALSHI_POLITICAL_CATEGORIES.some(cat =>
          m.category?.toLowerCase().includes(cat.toLowerCase())
        )
      );
    }

    // Additional category filter if specified
    if (category) {
      filtered = filtered.filter(m => {
        const text = `${m.title} ${m.category}`.toLowerCase();
        return text.includes(category.toLowerCase());
      });
    }

    logger.info(`Fetched ${filtered.length} Kalshi political markets${category ? ` matching "${category}"` : ''}`);
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

  // Test database connection (skip in dry-run mode)
  if (!dryRun) {
    const dbConnected = await testConnection();
    if (!dbConnected) {
      logger.error('Database connection failed');
      return { found: 0, added: 0 };
    }
  } else {
    logger.info('Dry-run mode: skipping database connection');
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
  if (!dryRun) {
    await eventMatcher.loadMappings();
  }

  let found = 0;
  let added = 0;

  // Show sample markets for debugging
  if (polymarketMarkets.length > 0) {
    logger.info('Sample Polymarket markets:');
    polymarketMarkets.slice(0, 3).forEach((m, i) => {
      logger.info(`  ${i + 1}. "${m.title.substring(0, 60)}..."`);
    });
  }
  if (kalshiMarkets.length > 0) {
    logger.info('Sample Kalshi markets:');
    kalshiMarkets.slice(0, 3).forEach((m, i) => {
      logger.info(`  ${i + 1}. "${m.title.substring(0, 60)}..."`);
    });
  }

  let noMatchCount = 0;
  const showNoMatchSamples = 5; // Show first N markets with their best non-match

  for (const polymarket of polymarketMarkets) {
    if (dryRun) {
      // Dry-run mode: use simple matching without database
      const match = findMatchDryRun(polymarket, kalshiMarkets);
      if (match) {
        found++;
        logger.info(`[DRY RUN] Match (${(match.confidence * 100).toFixed(0)}%): "${polymarket.title.substring(0, 50)}" → "${match.kalshiTitle.substring(0, 50)}"`);
      } else {
        // Show best match even if below threshold (for debugging)
        noMatchCount++;
        if (noMatchCount <= showNoMatchSamples) {
          const bestMatch = findMatchDryRun(polymarket, kalshiMarkets, 0.0); // No threshold
          if (bestMatch) {
            logger.debug(`[NO MATCH] Best (${(bestMatch.confidence * 100).toFixed(0)}%): "${polymarket.title.substring(0, 40)}" ≈ "${bestMatch.kalshiTitle.substring(0, 40)}"`);
          }
        }
      }
    } else {
      // Normal mode: use event matcher with database
      const existingMapping = eventMatcher.getMapping(polymarket.conditionId);
      if (existingMapping) {
        logger.debug(`Already mapped: ${polymarket.title.substring(0, 50)}...`);
        continue;
      }

      const mapping = await eventMatcher.findKalshiEquivalent(polymarket, kalshiMarkets);
      if (mapping) {
        found++;
        added++;
        logger.info(`✓ Matched: "${polymarket.title.substring(0, 40)}..." → ${mapping.kalshiTicker} (${(mapping.matchConfidence * 100).toFixed(1)}% confidence)`);
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
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose') || args.includes('-v');
  const preview = args.includes('--preview');
  const listSeries = args.includes('--list-series');
  const category = args.filter(a => !a.startsWith('--') && a !== '-v')[0] || undefined;

  if (verbose) {
    process.env.LOG_LEVEL = 'debug';
  }

  if (listSeries) {
    // List available Kalshi series/categories
    console.log('Fetching Kalshi series and events...\n');
    const connector = getKalshiConnector();
    connector.connect().then(async () => {
      const events = await connector.getEvents();

      // Group by category
      const byCategory: Record<string, Array<{ ticker: string; title: string }>> = {};
      for (const event of events) {
        const cat = event.category || 'Unknown';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push({ ticker: event.event_ticker, title: event.title });
      }

      console.log('=== KALSHI EVENTS BY CATEGORY ===\n');
      for (const [cat, evts] of Object.entries(byCategory).sort()) {
        console.log(`📁 ${cat} (${evts.length} events)`);
        evts.slice(0, 5).forEach(e => {
          console.log(`   - ${e.ticker}: ${e.title.substring(0, 50)}...`);
        });
        if (evts.length > 5) {
          console.log(`   ... and ${evts.length - 5} more`);
        }
        console.log('');
      }
    }).catch(console.error);
  } else if (preview) {
    // Just show sample markets without matching
    console.log('Fetching markets for preview...\n');
    Promise.all([
      fetchPolymarketMarkets(category),
      fetchKalshiMarkets(category),
    ]).then(([polymarkets, kalshiMarkets]) => {
      console.log('=== POLYMARKET MARKETS ===');
      polymarkets.slice(0, 10).forEach((m, i) => {
        console.log(`${i + 1}. ${m.title}`);
      });
      console.log(`\n... and ${Math.max(0, polymarkets.length - 10)} more\n`);

      console.log('=== KALSHI MARKETS ===');
      kalshiMarkets.slice(0, 10).forEach((m, i) => {
        console.log(`${i + 1}. ${m.title}`);
      });
      console.log(`\n... and ${Math.max(0, kalshiMarkets.length - 10)} more\n`);

      // Show best matches for first 5 Polymarket markets
      console.log('=== BEST POTENTIAL MATCHES ===');
      polymarkets.slice(0, 5).forEach((pm, i) => {
        const bestMatch = findMatchDryRun(pm, kalshiMarkets, 0.0);
        if (bestMatch) {
          console.log(`\n${i + 1}. Polymarket: "${pm.title.substring(0, 60)}..."`);
          console.log(`   Best Kalshi (${(bestMatch.confidence * 100).toFixed(0)}%): "${bestMatch.kalshiTitle.substring(0, 60)}..."`);
        }
      });
    }).catch(console.error);
  } else {
    autoDiscoverMappings({ category, dryRun })
    .then(async result => {
      console.log(`\nResults: ${result.found} found, ${result.added} added`);
      if (!dryRun) {
        await closePool();
      }
    })
    .catch(error => {
      console.error('Auto-discovery failed:', error);
      process.exit(1);
    });
  }
}
