/** Suma dos números. */
export function sum(a: number, b: number): number {
  return a + b;
}

/** Promedio de una lista; 0 si está vacía. */
export function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}
