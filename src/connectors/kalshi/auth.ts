import type { AxiosInstance } from 'axios';
import { getConfig } from '../../config/index.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger('kalshi-auth');

export interface KalshiSession {
  token: string;
  memberId: string;
  expiresAt: Date;
}

let currentSession: KalshiSession | null = null;

/**
 * Login to Kalshi API and get authentication token
 */
export async function login(client: AxiosInstance): Promise<KalshiSession | null> {
  const config = getConfig();

  if (!config.kalshi.email || !config.kalshi.password) {
    logger.error('Kalshi credentials not configured');
    return null;
  }

  try {
    const response = await client.post('/login', {
      email: config.kalshi.email,
      password: config.kalshi.password,
    });

    const { token, member_id } = response.data;

    // Token expires in 24 hours typically
    const expiresAt = new Date(Date.now() + 23 * 60 * 60 * 1000);

    currentSession = {
      token,
      memberId: member_id,
      expiresAt,
    };

    logger.info('Logged in to Kalshi', { memberId: member_id });

    return currentSession;
  } catch (error) {
    logger.error('Failed to login to Kalshi', {
      error: (error as Error).message,
    });
    return null;
  }
}

/**
 * Get current session or refresh if expired
 */
export async function getSession(client: AxiosInstance): Promise<KalshiSession | null> {
  if (!currentSession) {
    return login(client);
  }

  // Check if token is about to expire (within 1 hour)
  const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
  if (currentSession.expiresAt < oneHourFromNow) {
    logger.info('Session expiring soon, refreshing...');
    return login(client);
  }

  return currentSession;
}

/**
 * Get authorization header
 */
export function getAuthHeader(): Record<string, string> {
  if (!currentSession) {
    return {};
  }

  return {
    Authorization: `Bearer ${currentSession.token}`,
  };
}

/**
 * Clear current session (logout)
 */
export function clearSession(): void {
  currentSession = null;
  logger.info('Session cleared');
}

/**
 * Check if authenticated
 */
export function isAuthenticated(): boolean {
  if (!currentSession) return false;
  return currentSession.expiresAt > new Date();
}

/**
 * Get member ID
 */
export function getMemberId(): string | null {
  return currentSession?.memberId || null;
}
