import crypto from 'crypto';
import type { RetryPolicy } from '../types/index.js';
import { logger } from './logger.js';

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate a unique ID (UUID v4 format for database compatibility)
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Normalize text for comparison (lowercase, remove punctuation, trim)
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate Levenshtein distance between two strings
 */
export function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculate similarity score between two strings (0-1)
 */
export function levenshteinSimilarity(a: string, b: string): number {
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) return 1;

  const distance = levenshteinDistance(a, b);
  return 1 - distance / maxLength;
}

/**
 * Check if two dates match within a tolerance
 */
export function datesMatch(date1: Date, date2: Date, toleranceMs: number): boolean {
  return Math.abs(date1.getTime() - date2.getTime()) <= toleranceMs;
}

/**
 * Retry wrapper with exponential backoff
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryPolicy,
  context: string
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      const isRetryable = config.retryableErrors.some(
        errType => lastError?.message?.includes(errType)
      );

      if (!isRetryable || attempt === config.maxRetries) {
        logger.error(`${context} failed after ${attempt + 1} attempts`, { error: lastError.message });
        throw lastError;
      }

      const delay = Math.min(
        config.retryDelayMs * Math.pow(config.backoffMultiplier, attempt),
        config.maxRetryDelayMs
      );

      logger.warn(`${context} attempt ${attempt + 1} failed, retrying in ${delay}ms`, {
        error: lastError.message,
      });

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Round to specified decimal places
 */
export function round(value: number, decimals: number = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Format currency value
 */
export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Format percentage
 */
export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * Get today's date string in YYYY-MM-DD format
 */
export function getTodayString(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Parse date string to Date object
 */
export function parseDate(dateStr: string): Date {
  return new Date(dateStr);
}

/**
 * Check if a value is within bounds
 */
export function isWithinBounds(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/**
 * Clamp a value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Calculate slippage percentage
 */
export function calculateSlippage(expected: number, actual: number): number {
  if (expected === 0) return 0;
  return Math.abs(actual - expected) / expected;
}

/**
 * Deep clone an object
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Safely parse JSON with fallback
 */
export function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * Create a timeout promise
 */
export function timeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(message || `Operation timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]);
}
