/**
 * Construye UpdateExpression + nombres/valores sin colisiones con palabras reservadas
 * (`status`, `source`, `name`…). Reutilizable por cualquier módulo.
 */
export interface UpdateSpec {
  /** SET a = :v */
  set?: Record<string, unknown>;
  /** SET a = if_not_exists(a, :v) */
  setIfNotExists?: Record<string, unknown>;
  /** ADD a :v (números o Sets de strings) */
  add?: Record<string, number | Set<string>>;
}

export interface BuiltUpdate {
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
}

export function buildUpdate(spec: UpdateSpec): BuiltUpdate {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  const adds: string[] = [];
  let i = 0;
  const name = (k: string) => {
    const n = `#n${i}`;
    names[n] = k;
    return n;
  };
  const value = (v: unknown) => {
    const n = `:v${i++}`;
    values[n] = v;
    return n;
  };
  for (const [k, v] of Object.entries(spec.set ?? {})) {
    if (v === undefined) continue;
    const n = name(k);
    sets.push(`${n} = ${value(v)}`);
  }
  for (const [k, v] of Object.entries(spec.setIfNotExists ?? {})) {
    if (v === undefined) continue;
    const n = name(k);
    sets.push(`${n} = if_not_exists(${n}, ${value(v)})`);
  }
  for (const [k, v] of Object.entries(spec.add ?? {})) {
    if (v === undefined || (v instanceof Set && v.size === 0)) continue;
    const n = name(k);
    adds.push(`${n} ${value(v)}`);
  }
  const parts: string[] = [];
  if (sets.length) parts.push(`SET ${sets.join(', ')}`);
  if (adds.length) parts.push(`ADD ${adds.join(', ')}`);
  return { UpdateExpression: parts.join(' '), ExpressionAttributeNames: names, ExpressionAttributeValues: values };
}

export const chunk = <T>(xs: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
};
