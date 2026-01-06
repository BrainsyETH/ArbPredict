import pinoModule, { type Logger, pino } from 'pino';
import { getConfig } from '../config/index.js';

// Handle both ESM and CJS pino exports
const createPino = pino ?? pinoModule;

let loggerInstance: Logger | null = null;

export function getLogger(): Logger {
  if (!loggerInstance) {
    const config = getConfig();

    loggerInstance = createPino({
      level: config.logging.level,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  return loggerInstance!;
}

export function createChildLogger(context: string): Logger {
  return getLogger().child({ context });
}

export const logger = {
  debug: (msg: string, data?: object) => getLogger().debug(data, msg),
  info: (msg: string, data?: object) => getLogger().info(data, msg),
  warn: (msg: string, data?: object) => getLogger().warn(data, msg),
  error: (msg: string, data?: object) => getLogger().error(data, msg),
  fatal: (msg: string, data?: object) => getLogger().fatal(data, msg),
};
