import crypto from 'crypto';
import { getConfig } from '../../config/index.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger('kalshi-auth');

/**
 * Generate authentication headers for Kalshi API requests
 * Uses RSA-PSS signing with SHA256
 *
 * Required headers:
 * - KALSHI-ACCESS-KEY: The API key ID
 * - KALSHI-ACCESS-TIMESTAMP: Request timestamp in milliseconds
 * - KALSHI-ACCESS-SIGNATURE: RSA-PSS signed request hash (base64)
 */

let cachedPrivateKey: crypto.KeyObject | null = null;

/**
 * Parse and cache the private key
 */
function getPrivateKey(): crypto.KeyObject | null {
  if (cachedPrivateKey) {
    return cachedPrivateKey;
  }

  const config = getConfig();
  const privateKeyPem = config.kalshi.privateKey;

  if (!privateKeyPem) {
    logger.error('Kalshi private key not configured');
    return null;
  }

  try {
    // Handle key that might be passed as single line with \n literals
    const formattedKey = privateKeyPem.includes('\\n')
      ? privateKeyPem.replace(/\\n/g, '\n')
      : privateKeyPem;

    cachedPrivateKey = crypto.createPrivateKey({
      key: formattedKey,
      format: 'pem',
    });

    logger.debug('Private key loaded successfully');
    return cachedPrivateKey;
  } catch (error) {
    logger.error('Failed to parse Kalshi private key', {
      error: (error as Error).message,
    });
    return null;
  }
}

/**
 * Sign a message using RSA-PSS with SHA256
 */
function signMessage(message: string, privateKey: crypto.KeyObject): string {
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return signature.toString('base64');
}

/**
 * Generate authentication headers for a request
 *
 * @param method - HTTP method (GET, POST, DELETE, etc.)
 * @param path - Request path (e.g., /trade-api/v2/portfolio/balance)
 * @returns Headers object with authentication values
 */
export function getAuthHeaders(
  method: string,
  path: string
): Record<string, string> {
  const config = getConfig();

  if (!config.kalshi.apiKeyId) {
    logger.error('Kalshi API key ID not configured');
    return {};
  }

  const privateKey = getPrivateKey();
  if (!privateKey) {
    return {};
  }

  // Timestamp in milliseconds
  const timestamp = Date.now().toString();

  // Message to sign: timestamp + method + path (without query params)
  const pathWithoutQuery = path.split('?')[0];
  const message = `${timestamp}${method.toUpperCase()}${pathWithoutQuery}`;

  try {
    const signature = signMessage(message, privateKey);

    return {
      'KALSHI-ACCESS-KEY': config.kalshi.apiKeyId,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'KALSHI-ACCESS-SIGNATURE': signature,
    };
  } catch (error) {
    logger.error('Failed to sign request', {
      error: (error as Error).message,
    });
    return {};
  }
}

/**
 * Check if API key authentication is configured
 */
export function isConfigured(): boolean {
  const config = getConfig();
  return !!(config.kalshi.apiKeyId && config.kalshi.privateKey);
}

/**
 * Validate that the private key can be loaded
 */
export function validateCredentials(): boolean {
  if (!isConfigured()) {
    logger.error('Kalshi API credentials not configured');
    return false;
  }

  const privateKey = getPrivateKey();
  if (!privateKey) {
    logger.error('Failed to load Kalshi private key');
    return false;
  }

  logger.info('Kalshi API credentials validated');
  return true;
}

/**
 * Clear cached private key (for testing or credential rotation)
 */
export function clearCache(): void {
  cachedPrivateKey = null;
  logger.debug('Auth cache cleared');
}

// Legacy exports for backward compatibility during transition
// These can be removed once the connector is fully updated

export function getAuthHeader(): Record<string, string> {
  // This is a legacy function - new code should use getAuthHeaders with method/path
  logger.warn('Using legacy getAuthHeader - migrate to getAuthHeaders');
  return {};
}

export function isAuthenticated(): boolean {
  return isConfigured() && getPrivateKey() !== null;
}

export function clearSession(): void {
  clearCache();
}

// No longer needed with API key auth
export async function login(): Promise<boolean> {
  return validateCredentials();
}
