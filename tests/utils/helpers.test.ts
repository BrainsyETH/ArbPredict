import { describe, it, expect } from 'vitest';
import {
  normalize,
  levenshteinDistance,
  levenshteinSimilarity,
  datesMatch,
  round,
  formatUsd,
  formatPercent,
  calculateSlippage,
  clamp,
  isWithinBounds,
  getTodayString,
  generateId,
} from '../../src/utils/helpers.js';

describe('normalize', () => {
  it('should lowercase text', () => {
    expect(normalize('Hello World')).toBe('hello world');
  });

  it('should remove punctuation', () => {
    expect(normalize('Hello, World!')).toBe('hello world');
  });

  it('should trim whitespace', () => {
    expect(normalize('  hello  ')).toBe('hello');
  });

  it('should collapse multiple spaces', () => {
    expect(normalize('hello   world')).toBe('hello world');
  });
});

describe('levenshteinDistance', () => {
  it('should return 0 for identical strings', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
  });

  it('should return correct distance for different strings', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
  });

  it('should handle empty strings', () => {
    expect(levenshteinDistance('', 'hello')).toBe(5);
    expect(levenshteinDistance('hello', '')).toBe(5);
  });
});

describe('levenshteinSimilarity', () => {
  it('should return 1 for identical strings', () => {
    expect(levenshteinSimilarity('hello', 'hello')).toBe(1);
  });

  it('should return 0 for completely different strings of same length', () => {
    expect(levenshteinSimilarity('abc', 'xyz')).toBe(0);
  });

  it('should return value between 0 and 1', () => {
    const similarity = levenshteinSimilarity('hello', 'hallo');
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThan(1);
  });

  it('should return 1 for empty strings', () => {
    expect(levenshteinSimilarity('', '')).toBe(1);
  });
});

describe('datesMatch', () => {
  it('should return true for same dates', () => {
    const date = new Date('2025-01-01');
    expect(datesMatch(date, date, 1000)).toBe(true);
  });

  it('should return true for dates within tolerance', () => {
    const date1 = new Date('2025-01-01T00:00:00Z');
    const date2 = new Date('2025-01-01T12:00:00Z');
    const tolerance = 24 * 60 * 60 * 1000; // 24 hours
    expect(datesMatch(date1, date2, tolerance)).toBe(true);
  });

  it('should return false for dates outside tolerance', () => {
    const date1 = new Date('2025-01-01');
    const date2 = new Date('2025-01-03');
    const tolerance = 24 * 60 * 60 * 1000; // 24 hours
    expect(datesMatch(date1, date2, tolerance)).toBe(false);
  });
});

describe('round', () => {
  it('should round to 2 decimal places by default', () => {
    expect(round(3.14159)).toBe(3.14);
  });

  it('should round to specified decimal places', () => {
    expect(round(3.14159, 4)).toBe(3.1416);
  });

  it('should handle zero', () => {
    expect(round(0)).toBe(0);
  });
});

describe('formatUsd', () => {
  it('should format positive numbers', () => {
    expect(formatUsd(100)).toBe('$100.00');
  });

  it('should format decimal numbers', () => {
    expect(formatUsd(99.99)).toBe('$99.99');
  });

  it('should format zero', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });
});

describe('formatPercent', () => {
  it('should format decimal as percentage', () => {
    expect(formatPercent(0.5)).toBe('50.00%');
  });

  it('should format small decimals', () => {
    expect(formatPercent(0.03)).toBe('3.00%');
  });
});

describe('calculateSlippage', () => {
  it('should return 0 for same values', () => {
    expect(calculateSlippage(100, 100)).toBe(0);
  });

  it('should calculate positive slippage', () => {
    expect(calculateSlippage(100, 105)).toBe(0.05);
  });

  it('should calculate negative slippage as absolute value', () => {
    expect(calculateSlippage(100, 95)).toBe(0.05);
  });

  it('should return 0 for zero expected', () => {
    expect(calculateSlippage(0, 100)).toBe(0);
  });
});

describe('clamp', () => {
  it('should return value if within bounds', () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });

  it('should return min if value is below', () => {
    expect(clamp(-10, 0, 100)).toBe(0);
  });

  it('should return max if value is above', () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });
});

describe('isWithinBounds', () => {
  it('should return true for value within bounds', () => {
    expect(isWithinBounds(50, 0, 100)).toBe(true);
  });

  it('should return true for value at min', () => {
    expect(isWithinBounds(0, 0, 100)).toBe(true);
  });

  it('should return true for value at max', () => {
    expect(isWithinBounds(100, 0, 100)).toBe(true);
  });

  it('should return false for value below min', () => {
    expect(isWithinBounds(-1, 0, 100)).toBe(false);
  });

  it('should return false for value above max', () => {
    expect(isWithinBounds(101, 0, 100)).toBe(false);
  });
});

describe('getTodayString', () => {
  it('should return date in YYYY-MM-DD format', () => {
    const today = getTodayString();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('generateId', () => {
  it('should generate unique IDs', () => {
    const id1 = generateId();
    const id2 = generateId();
    expect(id1).not.toBe(id2);
  });

  it('should generate non-empty strings', () => {
    const id = generateId();
    expect(id.length).toBeGreaterThan(0);
  });
});
