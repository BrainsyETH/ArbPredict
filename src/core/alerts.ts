import type { AlertLevel } from '../types/index.js';
import { getConfig } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('alerts');

/**
 * Telegram alerter for critical notifications
 */
export class TelegramAlerter {
  private readonly enabled: boolean;
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly alertLevels: string[];
  private readonly baseUrl: string;

  constructor() {
    const config = getConfig();
    this.enabled = config.telegram.enabled;
    this.botToken = config.telegram.botToken;
    this.chatId = config.telegram.chatId;
    this.alertLevels = config.telegram.alertLevels;
    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;
  }

  /**
   * Check if alerts are enabled
   */
  isEnabled(): boolean {
    return this.enabled && !!this.botToken && !!this.chatId;
  }

  /**
   * Send an alert
   */
  async sendAlert(level: AlertLevel, message: string): Promise<void> {
    if (!this.isEnabled()) {
      logger.debug('Telegram alerts disabled, skipping');
      return;
    }

    if (!this.alertLevels.includes(level)) {
      logger.debug('Alert level not configured for sending', { level });
      return;
    }

    const emoji = {
      critical: '🚨',
      high: '⚠️',
      medium: 'ℹ️',
    }[level];

    const text = `${emoji} *ARB BOT ${level.toUpperCase()}*\n\n${this.escapeMarkdown(message)}`;

    try {
      const response = await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: text,
          parse_mode: 'Markdown',
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        logger.error('Failed to send Telegram alert', { error });
      } else {
        logger.debug('Telegram alert sent', { level });
      }
    } catch (error) {
      logger.error('Failed to send Telegram alert', {
        error: (error as Error).message,
      });
    }
  }

  /**
   * Alert: Circuit breaker triggered
   */
  async alertCircuitBreaker(reason: string): Promise<void> {
    await this.sendAlert(
      'critical',
      `Circuit breaker triggered!\n\nReason: ${reason}\n\nBot is paused. Manual review required.`
    );
  }

  /**
   * Alert: Asymmetric execution
   */
  async alertAsymmetricExecution(details: {
    buyResult: string;
    sellResult: string;
    buyPlatform: string;
    sellPlatform: string;
  }): Promise<void> {
    await this.sendAlert(
      'critical',
      `Asymmetric execution detected!\n\n` +
        `Buy (${details.buyPlatform}): ${details.buyResult}\n` +
        `Sell (${details.sellPlatform}): ${details.sellResult}\n\n` +
        `IMMEDIATE ATTENTION REQUIRED`
    );
  }

  /**
   * Alert: Daily loss limit reached
   */
  async alertDailyLossLimit(loss: number): Promise<void> {
    await this.sendAlert(
      'critical',
      `Daily loss limit reached!\n\nLoss: $${Math.abs(loss).toFixed(2)}\n\nTrading halted for today.`
    );
  }

  /**
   * Alert: Connection lost
   */
  async alertConnectionLost(platform: string): Promise<void> {
    await this.sendAlert(
      'high',
      `Connection lost to ${platform}\n\nAttempting reconnection...`
    );
  }

  /**
   * Alert: Trade executed
   */
  async alertTradeExecuted(trade: {
    buyPlatform: string;
    buyPrice: number;
    sellPlatform: string;
    sellPrice: number;
    profit: number;
  }): Promise<void> {
    await this.sendAlert(
      'medium',
      `Trade executed!\n\n` +
        `Buy: ${trade.buyPlatform} @ $${trade.buyPrice.toFixed(4)}\n` +
        `Sell: ${trade.sellPlatform} @ $${trade.sellPrice.toFixed(4)}\n` +
        `Profit: $${trade.profit.toFixed(2)}`
    );
  }

  /**
   * Alert: Bot started
   */
  async alertBotStarted(mode: string): Promise<void> {
    await this.sendAlert(
      'medium',
      `Bot started in ${mode.toUpperCase()} mode\n\nMonitoring for opportunities...`
    );
  }

  /**
   * Alert: Bot stopped
   */
  async alertBotStopped(reason?: string): Promise<void> {
    await this.sendAlert(
      'high',
      `Bot stopped${reason ? `\n\nReason: ${reason}` : ''}`
    );
  }

  /**
   * Escape markdown special characters
   */
  private escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
  }
}

// Singleton instance
let telegramAlerter: TelegramAlerter | null = null;

export function getTelegramAlerter(): TelegramAlerter {
  if (!telegramAlerter) {
    telegramAlerter = new TelegramAlerter();
  }
  return telegramAlerter;
}
