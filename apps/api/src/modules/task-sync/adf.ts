/**
 * Markdown (subconjunto) → Atlassian Document Format (Jira Cloud REST v3).
 * Soporta: párrafos (línea en blanco), saltos de línea, **negrita**, `código`, [enlace](https://…),
 * URLs sueltas, listas con viñetas (`- ` / `* `) y bloques ``` de código. Todo lo demás → texto.
 * Docs: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
 */

export type AdfMark = { type: 'strong' } | { type: 'code' } | { type: 'link'; attrs: { href: string } };
export type AdfInline = { type: 'text'; text: string; marks?: AdfMark[] } | { type: 'hardBreak' };
export type AdfBlock =
  | { type: 'paragraph'; content: AdfInline[] }
  | { type: 'bulletList'; content: Array<{ type: 'listItem'; content: Array<{ type: 'paragraph'; content: AdfInline[] }> }> }
  | { type: 'codeBlock'; content: Array<{ type: 'text'; text: string }> };
export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfBlock[];
}

const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g;

export function inlineToAdf(text: string): AdfInline[] {
  const out: AdfInline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ type: 'text', text: text.slice(last, idx) });
    if (m[1] !== undefined) out.push({ type: 'text', text: m[1], marks: [{ type: 'strong' }] });
    else if (m[2] !== undefined) out.push({ type: 'text', text: m[2], marks: [{ type: 'code' }] });
    else if (m[3] !== undefined) out.push({ type: 'text', text: m[3], marks: [{ type: 'link', attrs: { href: m[4]! } }] });
    else if (m[5] !== undefined) out.push({ type: 'text', text: m[5], marks: [{ type: 'link', attrs: { href: m[5] } }] });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out.filter((n) => n.type !== 'text' || n.text.length > 0);
}

const BULLET = /^\s*[-*]\s+(.*)$/;

function paragraph(lines: string[]): AdfBlock | null {
  const content: AdfInline[] = [];
  lines.forEach((l, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    content.push(...inlineToAdf(l));
  });
  return content.some((c) => c.type === 'text') ? { type: 'paragraph', content } : null;
}

export function markdownToAdf(markdown: string): AdfDoc {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: AdfBlock[] = [];
  let para: string[] = [];
  let list: string[] = [];

  const flushPara = () => {
    const p = paragraph(para);
    if (p) blocks.push(p);
    para = [];
  };
  const flushList = () => {
    if (list.length) {
      blocks.push({
        type: 'bulletList',
        content: list.map((item) => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: inlineToAdf(item).length ? inlineToAdf(item) : [{ type: 'text', text: ' ' }] }],
        })),
      });
    }
    list = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flushPara();
      flushList();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      const text = code.join('\n');
      blocks.push({ type: 'codeBlock', content: text ? [{ type: 'text', text }] : [] });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      flushPara();
      list.push(bullet[1]!);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  if (!blocks.length) blocks.push({ type: 'paragraph', content: [{ type: 'text', text: markdown.trim() || ' ' }] });
  return { type: 'doc', version: 1, content: blocks };
}
