import { describe, expect, it } from 'vitest';
import { average, sum } from './math';

describe('math', () => {
  it('sum', () => {
    expect(sum(1, 2)).toBe(3);
  });

  it('average', () => {
    expect(average([2, 4, 6])).toBe(4);
    expect(average([])).toBe(0);
  });
});
