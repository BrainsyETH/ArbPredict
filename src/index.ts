import * as readline from 'readline';
import { getConfig } from './config/index.js';
import { getStateManager } from './core/state.js';
import { getCircuitBreaker } from './core/circuit-breaker.js';
import { getTelegramAlerter } from './core/alerts.js';
import { getPolymarketConnector } from './connectors/polymarket/index.js';
import { testConnection as testDbConnection, closePool } from './db/index.js';
import { createChildLogger } from './utils/logger.js';
import { formatUsd } from './utils/helpers.js';

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
  'opportunities': 'Show current arbitrage opportunities',
  'config': 'Show current configuration',
  'help': 'Show available commands',
  'quit': 'Exit the bot',
};

async function handleCommand(command: string, args: string[]): Promise<string> {
  const config = getConfig();
  const stateManager = getStateManager();
  const circuitBreaker = getCircuitBreaker();
  const polymarketConnector = getPolymarketConnector();

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

      return `
Connection Health:
  Polymarket REST: ${polyConnected ? '✓ Connected' : '✗ Disconnected'}
  Polymarket WebSocket: ${polyWsConnected ? '✓ Connected' : '✗ Disconnected'}
  Kalshi REST: Not implemented yet
  Kalshi WebSocket: Not implemented yet
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
      const balances = await polymarketConnector.getBalances();
      return `
Balances:
  Polymarket:
    Available: ${formatUsd(balances.available)} ${balances.currency}
    Locked: ${formatUsd(balances.locked)} ${balances.currency}
    Total: ${formatUsd(balances.total)} ${balances.currency}
  Kalshi: Not implemented yet
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

    case 'opportunities': {
      return 'Opportunity scanning not yet implemented.\nThis will show detected arbitrage opportunities.';
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
 * Graceful shutdown
 */
async function shutdown(): Promise<void> {
  logger.info('Shutting down...');

  const stateManager = getStateManager();
  const polymarketConnector = getPolymarketConnector();
  const alerter = getTelegramAlerter();

  // Stop auto-save
  stateManager.stopAutoSave();

  // Save final state
  await stateManager.save();

  // Disconnect from platforms
  await polymarketConnector.disconnect();

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

  // Send startup alert
  const alerter = getTelegramAlerter();
  await alerter.alertBotStarted(config.operatingMode.mode);

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
