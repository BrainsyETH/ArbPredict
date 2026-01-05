import pino from 'pino';
import { getConfig } from '../config/index.js';

let loggerInstance: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (!loggerInstance) {
    const config = getConfig();

    loggerInstance = pino({
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

  return loggerInstance;
}

export function createChildLogger(context: string): pino.Logger {
  return getLogger().child({ context });
}

export const logger = {
  debug: (msg: string, data?: object) => getLogger().debug(data, msg),
  info: (msg: string, data?: object) => getLogger().info(data, msg),
  warn: (msg: string, data?: object) => getLogger().warn(data, msg),
  error: (msg: string, data?: object) => getLogger().error(data, msg),
  fatal: (msg: string, data?: object) => getLogger().fatal(data, msg),
};
