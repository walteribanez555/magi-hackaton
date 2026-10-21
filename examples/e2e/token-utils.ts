export function sumPositiveTokens(values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (value > 0) total += value;
  }
  return total;
}
