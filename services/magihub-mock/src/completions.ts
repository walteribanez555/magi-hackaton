import { createHash } from 'node:crypto';

/**
 * SIMULADO — "Smart Auto": elige un modelo concreto por tamaño del prompt y devuelve código
 * determinista (mismo prompt ⇒ misma salida ⇒ mismo output_hash, útil para detectar regeneraciones).
 */

export interface ChatMessage {
  role: string;
  content: string | Array<{ type?: string; text?: string }>;
}

export const textOf = (m: ChatMessage): string =>
  typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join('');

/** Smart Auto simulado: prompts cortos → modelo barato; largos → modelo grande. */
export const routeModel = (promptChars: number): string => (promptChars < 600 ? 'mock-haiku' : 'mock-sonnet');

/** ≈ 4 caracteres por token (aproximación declarada del mock). */
export const tokensOf = (chars: number): number => Math.max(1, Math.ceil(chars / 4));

/** Precios SIMULADOS (USD por millón de tokens) — solo para que el dashboard muestre costo etiquetado. */
const PRICES: Record<string, { input: number; output: number }> = {
  'mock-haiku': { input: 0.25, output: 1.25 },
  'mock-sonnet': { input: 3, output: 15 },
};
export function costOf(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICES[model] ?? PRICES['mock-sonnet']!;
  return Math.round(((promptTokens * p.input + completionTokens * p.output) / 1_000_000) * 1e6) / 1e6;
}

const nameFrom = (prompt: string, fallback: string): string => {
  const m = /(?:function|funci[oó]n|m[eé]todo|method)\s+(?:llamada\s+|named\s+)?`?([A-Za-z_$][\w$]*)/i.exec(prompt);
  const n = m?.[1];
  return n && !['que', 'para', 'with', 'that', 'to', 'de'].includes(n.toLowerCase()) ? n : fallback;
};

const fence = (lang: string, code: string) => '```' + lang + '\n' + code.trimEnd() + '\n```';

function functionWithTest(prompt: string): string {
  const name = nameFrom(prompt, 'sumPositive');
  const impl = `export function ${name}(values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (value > 0) total += value;
  }
  return total;
}`;
  const test = `import { describe, expect, it } from 'vitest';
import { ${name} } from './${name}';

describe('${name}', () => {
  it('suma solo los valores positivos', () => {
    expect(${name}([1, -2, 3])).toBe(4);
  });

  it('devuelve 0 con una lista vacía', () => {
    expect(${name}([])).toBe(0);
  });
});`;
  return `Implementación en TypeScript con su prueba unitaria (Vitest):\n\n${fence('ts', impl)}\n\n${fence('ts', test)}\n`;
}

function reactComponent(prompt: string): string {
  const name = /componente?\s+`?([A-Z][\w]*)/.exec(prompt)?.[1] ?? 'Counter';
  return `Componente React con estado local:\n\n${fence(
    'tsx',
    `import { useState } from 'react';

export function ${name}({ initial = 0 }: { initial?: number }) {
  const [count, setCount] = useState(initial);
  return (
    <button type="button" onClick={() => setCount((c) => c + 1)}>
      Clicks: {count}
    </button>
  );
}`,
  )}\n`;
}

function sqlQuery(): string {
  return `Consulta SQL:\n\n${fence(
    'sql',
    `SELECT customer_id, SUM(amount) AS total
FROM orders
WHERE created_at >= now() - interval '30 days'
GROUP BY customer_id
ORDER BY total DESC
LIMIT 10;`,
  )}\n`;
}

function pythonFunction(prompt: string): string {
  const name = nameFrom(prompt, 'sum_positive');
  return `Función en Python:\n\n${fence(
    'python',
    `def ${name}(values: list[float]) -> float:
    return sum(v for v in values if v > 0)`,
  )}\n`;
}

function jsonConfig(): string {
  return `Configuración sugerida:\n\n${fence(
    'json',
    `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "strict": true,
    "outDir": "dist"
  },
  "include": ["src"]
}`,
  )}\n`;
}

function genericFunction(prompt: string): string {
  const name = nameFrom(prompt, 'normalizeInput');
  return `Propuesta:\n\n${fence(
    'ts',
    `export function ${name}(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\\s+/g, ' ').toLowerCase();
}`,
  )}\n`;
}

/** Respuesta canned según el último mensaje del usuario. */
export function generateCompletion(prompt: string): string {
  const p = prompt.toLowerCase();
  if (/(test|prueba|spec)/.test(p) && /(function|funci[oó]n|method|m[eé]todo)/.test(p)) return functionWithTest(prompt);
  if (/(react|component)/.test(p)) return reactComponent(prompt);
  if (/(sql|query|consulta)/.test(p)) return sqlQuery();
  if (/python/.test(p)) return pythonFunction(prompt);
  if (/(tsconfig|config|json)/.test(p)) return jsonConfig();
  return genericFunction(prompt);
}

export const outputHash = (content: string): string => createHash('sha256').update(content).digest('hex').slice(0, 16);
