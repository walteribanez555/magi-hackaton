import { describe, expect, it } from 'vitest';
import { sumPositiveTokens } from './token-utils';

describe('sumPositiveTokens', () => {
  it('suma solo los valores positivos', () => {
    expect(sumPositiveTokens([1, -2, 3])).toBe(4);
  });

  it('devuelve 0 con una lista vacía', () => {
    expect(sumPositiveTokens([])).toBe(0);
  });
});
