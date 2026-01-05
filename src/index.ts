import * as readline from 'readline';
import { getConfig } from './config/index.js';
import { getStateManager } from './core/state.js';
import { getCircuitBreaker } from './core/circuit-breaker.js';
import { getTelegramAlerter } from './core/alerts.js';
import { getEventMatcher } from './core/event-matcher.js';
import { getArbitrageDetector } from './core/arbitrage-detector.js';
import { getExecutionEngine } from './core/execution-engine.js';
import { getRiskManager } from './core/risk-manager.js';
import { getPolymarketConnector } from './connectors/polymarket/index.js';
import { getKalshiConnector } from './connectors/kalshi/index.js';
import { testConnection as testDbConnection, closePool } from './db/index.js';
import { createChildLogger } from './utils/logger.js';
import { formatUsd, sleep, round } from './utils/helpers.js';

const logger = createChildLogger('main');

/**
 * CLI command handlers
 */
const CLI_COMMANDS: Record<string, string> = {
  'status': 'Show bot status, positions, and P&L',
  'health': 'Check connection health to both platforms',
  'positions': 'List all open positions',
  'balance': 'Show balances on both platforms',
  'pause': 'Pause trading (trigger circuit breaker)',
  'resume': 'Resume trading (clear circuit breaker)',
  'dry-run': 'Switch to dry run mode',
  'live': 'Switch to live mode (requires confirmation)',
  'scan': 'Scan for arbitrage opportunities',
  'mappings': 'Show active event mappings',
  'opportunities': 'Show current arbitrage opportunities',
  'config': 'Show current configuration',
  'help': 'Show available commands',
  'quit': 'Exit the bot',
};

// Bot loop control
let botRunning = false;
let scanInterval: NodeJS.Timer | null = null;

async function handleCommand(command: string, args: string[]): Promise<string> {
  const config = getConfig();
  const stateManager = getStateManager();
  const circuitBreaker = getCircuitBreaker();
  const polymarketConnector = getPolymarketConnector();
  const kalshiConnector = getKalshiConnector();
  const eventMatcher = getEventMatcher();
  const arbitrageDetector = getArbitrageDetector();
  const riskManager = getRiskManager();

  switch (command) {
    case 'status': {
      const state = stateManager.getState();
      const cbStatus = circuitBreaker.getStatus();

      return `
Bot Status:
  Mode: ${config.operatingMode.mode.toUpperCase()}
  Circuit Breaker: ${cbStatus.paused ? `PAUSED (${cbStatus.reason})` : 'Active'}
  Daily P&L: ${formatUsd(state.dailyPnL)}
  Daily Trades: ${state.dailyTradeCount}
  Daily Volume: ${formatUsd(state.dailyVolumeUsd)}
  Open Positions: ${state.openPositions.length}
  Last Trade: ${state.lastSuccessfulTrade || 'None'}
      `.trim();
    }

    case 'health': {
      const polyConnected = polymarketConnector.isConnected();
      const polyWsConnected = polymarketConnector.isWebSocketConnected();
      const kalshiConnected = kalshiConnector.isConnected();
      const kalshiWsConnected = kalshiConnector.isWebSocketConnected();

      return `
Connection Health:
  Polymarket REST: ${polyConnected ? '✓ Connected' : '✗ Disconnected'}
  Polymarket WebSocket: ${polyWsConnected ? '✓ Connected' : '✗ Disconnected'}
  Kalshi REST: ${kalshiConnected ? '✓ Connected' : '✗ Disconnected'}
  Kalshi WebSocket: ${kalshiWsConnected ? '✓ Connected' : '✗ Disconnected'}
  Bot Running: ${botRunning ? '✓ Active' : '✗ Stopped'}
      `.trim();
    }

    case 'positions': {
      const positions = stateManager.getOpenPositions();
      if (positions.length === 0) {
        return 'No open positions';
      }

      let output = 'Open Positions:\n';
      for (const pos of positions) {
        output += `  ${pos.platform} | ${pos.eventId} | ${pos.side.toUpperCase()} | `;
        output += `Qty: ${pos.quantity} | Avg: ${formatUsd(pos.avgPrice)} | `;
        output += `P&L: ${formatUsd(pos.unrealizedPnL)}\n`;
      }
      return output.trim();
    }

    case 'balance': {
      const polyBalances = await polymarketConnector.getBalances();
      const kalshiBalances = await kalshiConnector.getBalances();
      return `
Balances:
  Polymarket:
    Available: ${formatUsd(polyBalances.available)} ${polyBalances.currency}
    Total: ${formatUsd(polyBalances.total)} ${polyBalances.currency}
  Kalshi:
    Available: ${formatUsd(kalshiBalances.available)} ${kalshiBalances.currency}
    Total: ${formatUsd(kalshiBalances.total)} ${kalshiBalances.currency}
  Combined: ${formatUsd(polyBalances.total + kalshiBalances.total)}
      `.trim();
    }

    case 'pause': {
      circuitBreaker.pause('Manual pause via CLI');
      return 'Trading paused';
    }

    case 'resume': {
      if (!circuitBreaker.isPaused()) {
        return 'Circuit breaker is not paused';
      }
      circuitBreaker.resume();
      return 'Trading resumed';
    }

    case 'dry-run': {
      config.operatingMode.mode = 'dry_run';
      return 'Switched to DRY RUN mode - no real trades will be executed';
    }

    case 'live': {
      if (args[0] !== '--confirm') {
        return 'WARNING: This will enable live trading with real money.\nRun "live --confirm" to proceed.';
      }
      config.operatingMode.mode = 'live';
      return 'Switched to LIVE mode - real trades will be executed';
    }

    case 'scan': {
      try {
        const opportunities = await arbitrageDetector.scanForOpportunities();
        if (opportunities.length === 0) {
          return 'No arbitrage opportunities found.';
        }

        let output = `Found ${opportunities.length} opportunity(ies):\n`;
        for (const opp of opportunities) {
          output += `\n  ${opp.id.substring(0, 8)}...\n`;
          output += `    Buy: ${opp.buyPlatform} @ ${formatUsd(opp.buyPrice)}\n`;
          output += `    Sell: ${opp.sellPlatform} @ ${formatUsd(opp.sellPrice)}\n`;
          output += `    Spread: ${round(opp.grossSpread * 100, 2)}%\n`;
          output += `    Net Profit: ${formatUsd(opp.netProfit)} per contract\n`;
          output += `    Max Qty: ${opp.maxQuantity}\n`;
        }
        return output.trim();
      } catch (error) {
        return `Scan failed: ${(error as Error).message}`;
      }
    }

    case 'mappings': {
      const mappings = eventMatcher.getActiveMappings();
      if (mappings.length === 0) {
        return 'No active event mappings. Use event matcher to build mappings.';
      }

      let output = `Active Event Mappings (${mappings.length}):\n`;
      for (const mapping of mappings) {
        output += `\n  ${mapping.eventDescription.substring(0, 40)}...\n`;
        output += `    Poly: ${mapping.polymarketConditionId.substring(0, 16)}...\n`;
        output += `    Kalshi: ${mapping.kalshiTicker}\n`;
        output += `    Confidence: ${round(mapping.matchConfidence * 100, 1)}% (${mapping.matchMethod})\n`;
      }
      return output.trim();
    }

    case 'opportunities': {
      const mappings = eventMatcher.getActiveMappings();
      let output = 'Current Opportunities by Mapping:\n';
      let found = 0;

      for (const mapping of mappings) {
        const opp = arbitrageDetector.getLastOpportunity(mapping.id);
        if (opp) {
          found++;
          output += `\n  ${mapping.eventDescription.substring(0, 30)}...\n`;
          output += `    ${opp.buyPlatform} -> ${opp.sellPlatform}\n`;
          output += `    Net: ${formatUsd(opp.netProfit)}/contract\n`;
        }
      }

      if (found === 0) {
        return 'No recent opportunities cached. Run "scan" to detect opportunities.';
      }

      return output.trim();
    }

    case 'config': {
      return `
Configuration:
  Trading Mode: ${config.operatingMode.mode}
  Max Exposure Per Event: ${formatUsd(config.risk.maxExposurePerEvent)}
  Max Total Exposure: ${formatUsd(config.risk.maxTotalExposure)}
  Daily Loss Limit: ${formatUsd(config.risk.dailyLossLimit)}
  Min Profit Threshold: ${(config.risk.minProfitThreshold * 100).toFixed(1)}%
  Max Slippage: ${(config.risk.maxSlippageTolerance * 100).toFixed(1)}%
  Min Confidence: ${(config.matching.minConfidenceThreshold * 100).toFixed(0)}%
  Order Type: ${config.trading.orderType}
  Telegram Alerts: ${config.telegram.enabled ? 'Enabled' : 'Disabled'}
      `.trim();
    }

    case 'help': {
      let output = 'Available Commands:\n';
      for (const [cmd, desc] of Object.entries(CLI_COMMANDS)) {
        output += `  ${cmd.padEnd(15)} ${desc}\n`;
      }
      return output.trim();
    }

    case 'quit':
    case 'exit': {
      return 'QUIT';
    }

    default: {
      return `Unknown command: ${command}\nType "help" for available commands.`;
    }
  }
}

/**
 * Start CLI interface
 */
function startCli(): readline.Interface {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'arb> ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    const [command, ...args] = trimmed.split(' ');
    const result = await handleCommand(command.toLowerCase(), args);

    if (result === 'QUIT') {
      console.log('Shutting down...');
      rl.close();
      return;
    }

    console.log(result);
    console.log();
    rl.prompt();
  });

  rl.on('close', async () => {
    await shutdown();
  });

  return rl;
}

/**
 * Perform startup checks
 */
async function performStartupChecks(): Promise<{ canStart: boolean; warnings: string[] }> {
  const config = getConfig();
  const stateManager = getStateManager();
  const warnings: string[] = [];

  // Load persisted state
  await stateManager.load();

  // Check state age
  const stateAge = stateManager.getStateAgeMinutes();
  if (stateAge > config.crashRecovery.maxStateAgeMinutes) {
    warnings.push(`State is ${stateAge.toFixed(0)} minutes old - may be stale`);
  }

  // Check circuit breaker
  if (stateManager.isCircuitBreakerPaused()) {
    warnings.push(`Circuit breaker was paused: ${stateManager.getCircuitBreakerReason()}`);
  }

  // Check daily loss
  const dailyPnL = stateManager.getDailyPnL();
  if (dailyPnL < -config.risk.dailyLossLimit) {
    warnings.push(`Daily loss limit reached: ${formatUsd(Math.abs(dailyPnL))}`);
  }

  const canStart = !config.crashRecovery.requireManualReview || warnings.length === 0;

  return { canStart, warnings };
}

/**
 * Stop the bot loop
 */
function stopBotLoop(): void {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
  botRunning = false;
  logger.info('Bot loop stopped');
}

/**
 * Start the bot loop (scans for opportunities periodically)
 */
function startBotLoop(): void {
  if (botRunning) {
    logger.warn('Bot loop already running');
    return;
  }

  const config = getConfig();
  botRunning = true;

  logger.info('Starting bot loop...');

  // Scan every 5 seconds
  scanInterval = setInterval(async () => {
    if (!botRunning) return;

    const circuitBreaker = getCircuitBreaker();
    if (circuitBreaker.isPaused()) {
      return; // Don't scan if paused
    }

    try {
      const arbitrageDetector = getArbitrageDetector();
      const executionEngine = getExecutionEngine();

      // Clean up expired opportunities
      arbitrageDetector.clearExpired();

      // Scan for new opportunities
      const opportunities = await arbitrageDetector.scanForOpportunities();

      // Execute the best opportunity if any
      if (opportunities.length > 0) {
        // Sort by net profit
        opportunities.sort((a, b) => b.netProfit - a.netProfit);
        const bestOpp = opportunities[0];

        logger.info('Attempting to execute opportunity', {
          id: bestOpp.id,
          netProfit: bestOpp.netProfit,
        });

        const result = await executionEngine.execute(bestOpp);

        if (result.success) {
          logger.info('Execution successful', {
            profit: result.actualProfit,
            slippage: result.slippage,
          });
        } else if (result.circuitBreakerTriggered) {
          logger.error('Circuit breaker triggered during execution');
        }
      }
    } catch (error) {
      logger.error('Error in bot loop', { error: (error as Error).message });
    }
  }, 5000);
}

/**
 * Graceful shutdown
 */
async function shutdown(): Promise<void> {
  logger.info('Shutting down...');

  // Stop bot loop
  stopBotLoop();

  const stateManager = getStateManager();
  const polymarketConnector = getPolymarketConnector();
  const kalshiConnector = getKalshiConnector();
  const alerter = getTelegramAlerter();

  // Stop auto-save
  stateManager.stopAutoSave();

  // Save final state
  await stateManager.save();

  // Disconnect from platforms
  await polymarketConnector.disconnect();
  await kalshiConnector.disconnect();

  // Close database connection
  await closePool();

  // Send shutdown alert
  await alerter.alertBotStopped();

  logger.info('Shutdown complete');
  process.exit(0);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const config = getConfig();

  console.log('='.repeat(60));
  console.log('Polymarket-Kalshi Arbitrage Bot v0.1.0');
  console.log('='.repeat(60));
  console.log();

  // Display mode warning
  if (config.operatingMode.mode === 'live') {
    console.log('⚠️  WARNING: Running in LIVE mode - real trades will be executed');
  } else {
    console.log('ℹ️  Running in DRY RUN mode - no real trades will be executed');
  }
  console.log();

  // Initialize components
  logger.info('Initializing...');

  // Test database connection
  logger.info('Testing database connection...');
  const dbConnected = await testDbConnection();
  if (!dbConnected) {
    logger.warn('Database connection failed - some features may be unavailable');
  }

  // Initialize state manager
  const stateManager = getStateManager();
  await stateManager.load();
  stateManager.startAutoSave();

  // Initialize circuit breaker
  const circuitBreaker = getCircuitBreaker();
  await circuitBreaker.initialize();

  // Perform startup checks
  const { canStart, warnings } = await performStartupChecks();

  if (warnings.length > 0) {
    console.log('Startup Warnings:');
    for (const warning of warnings) {
      console.log(`  ⚠️  ${warning}`);
    }
    console.log();
  }

  if (!canStart) {
    console.log('Cannot auto-start due to warnings above.');
    console.log('Use "resume" command after reviewing the situation.');
    console.log();
  }

  // Connect to Polymarket
  logger.info('Connecting to Polymarket...');
  const polymarketConnector = getPolymarketConnector();
  const polyConnected = await polymarketConnector.connect();

  if (polyConnected) {
    logger.info('Connected to Polymarket REST API');

    // Connect WebSocket
    const wsConnected = await polymarketConnector.connectWebSocket();
    if (wsConnected) {
      logger.info('Connected to Polymarket WebSocket');
    } else {
      logger.warn('Failed to connect to Polymarket WebSocket');
    }
  } else {
    logger.error('Failed to connect to Polymarket');
  }

  // Connect to Kalshi
  logger.info('Connecting to Kalshi...');
  const kalshiConnector = getKalshiConnector();
  const kalshiConnected = await kalshiConnector.connect();

  if (kalshiConnected) {
    logger.info('Connected to Kalshi REST API');

    // Connect WebSocket
    const kalshiWsConnected = await kalshiConnector.connectWebSocket();
    if (kalshiWsConnected) {
      logger.info('Connected to Kalshi WebSocket');
    } else {
      logger.warn('Failed to connect to Kalshi WebSocket');
    }
  } else {
    logger.warn('Failed to connect to Kalshi - check credentials');
  }

  // Load event mappings
  logger.info('Loading event mappings...');
  const eventMatcher = getEventMatcher();
  await eventMatcher.loadMappings();
  const mappings = eventMatcher.getActiveMappings();
  logger.info(`Loaded ${mappings.length} event mappings`);

  // Send startup alert
  const alerter = getTelegramAlerter();
  await alerter.alertBotStarted(config.operatingMode.mode);

  // Start bot loop if can start
  if (canStart) {
    startBotLoop();
  }

  console.log();
  console.log('Bot initialized. Type "help" for available commands.');
  console.log();

  // Handle shutdown signals
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start CLI
  startCli();
}

// Run main
main().catch((error) => {
  logger.fatal('Fatal error', { error: error.message });
  process.exit(1);
});
