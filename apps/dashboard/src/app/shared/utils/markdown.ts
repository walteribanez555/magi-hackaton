/**
 * Renderizador Markdown mínimo y SEGURO para los artículos de la guía (public/kb/*.md).
 *
 * Soporta: encabezados (#..######), párrafos, listas (- * + y 1.), tablas con fila separadora,
 * bloques de código ``` (con o sin lenguaje), código en línea, **negrita**, *cursiva* / _cursiva_,
 * enlaces [texto](url), citas (>) y reglas (---).
 *
 * Seguridad: TODO texto de entrada pasa por `escapeHtml` antes de envolverse en etiquetas
 * generadas aquí; nunca se copia HTML crudo. Los enlaces solo admiten http(s), mailto,
 * anclas y rutas relativas; `javascript:`, `data:` y similares se descartan (queda el texto).
 */

export interface MarkdownOptions {
  /**
   * Reescribe un href relativo (p. ej. "tokens.md" → "/guia/tokens"). Si devuelve null se
   * deja el href original (ya validado).
   */
  resolveLink?: (href: string) => string | null;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/** ¿El href es seguro? Protocolos permitidos o rutas relativas/anclas. */
export function isSafeHref(href: string): boolean {
  // Elimina espacios y caracteres de control que los navegadores ignoran ("java\tscript:").
  // eslint-disable-next-line no-control-regex
  const cleaned = href.replace(/[\u0000- \u007F-\u009F]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (!scheme) return true; // relativo, ancla o ruta absoluta del sitio
  return ['http', 'https', 'mailto'].includes(scheme[1]!.toLowerCase());
}

export function isExternalHref(href: string): boolean {
  return /^(https?:)?\/\//i.test(href) || /^mailto:/i.test(href);
}

/** Inline: código, enlaces, negrita, cursiva. Devuelve HTML ya escapado. */
export function renderInline(src: string, opts: MarkdownOptions = {}): string {
  let out = '';
  // Separa los spans de código primero: su contenido no recibe más formato.
  const parts = src.split(/(`+[^`]*?`+)/g);
  for (const part of parts) {
    const code = /^(`+)([^`]*?)\1$/.exec(part);
    if (code && part.length > 1) {
      out += `<code>${escapeHtml(code[2]!.trim() === '' ? code[2]! : code[2]!.replace(/^ (.*) $/, '$1'))}</code>`;
    } else {
      out += renderEmphasisAndLinks(part, opts);
    }
  }
  return out;
}

function renderEmphasisAndLinks(text: string, opts: MarkdownOptions): string {
  // Enlaces sobre el texto crudo, el resto se escapa por tramos.
  const linkRe = /\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(linkRe)) {
    out += emphasis(escapeHtml(text.slice(last, m.index)));
    const label = emphasis(escapeHtml(m[1]!));
    const rawHref = m[2]!;
    if (isSafeHref(rawHref)) {
      const resolved = opts.resolveLink?.(rawHref) ?? rawHref;
      const ext = isExternalHref(resolved);
      out += `<a href="${escapeHtml(resolved)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
    } else {
      out += label;
    }
    last = m.index! + m[0].length;
  }
  out += emphasis(escapeHtml(text.slice(last)));
  return out;
}

/** Negrita y cursiva sobre texto YA escapado (los marcadores * y _ no se escapan). */
function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/g, '$1<em>$2</em>');
}

const isTableSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  // Respeta \| y los | dentro de `código`.
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function alignOf(sep: string): string {
  const s = sep.trim();
  if (s.startsWith(':') && s.endsWith(':')) return 'center';
  if (s.endsWith(':')) return 'right';
  return '';
}

/** Markdown → HTML seguro. */
export function renderMarkdown(src: string, opts: MarkdownOptions = {}): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;
  const inline = (s: string) => renderInline(s, opts);

  while (i < lines.length) {
    const line = lines[i]!;

    // Código cercado
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const close = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(close)) body.push(lines[i++]!);
      i++; // cierre
      const lang = fence[2] ? ` data-lang="${escapeHtml(fence[2])}"` : '';
      html.push(`<pre${lang}><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    // Encabezado
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const text = h[2]!;
      const id = slugify(text);
      html.push(`<h${level} id="${escapeHtml(id)}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }

    // Regla
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html.push('<hr>');
      i++;
      continue;
    }

    // Tabla
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]!).map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      const attr = (k: number) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : '');
      const thead = head.map((c, k) => `<th scope="col"${attr(k)}>${inline(c)}</th>`).join('');
      const tbody = rows
        .map((r) => `<tr>${head.map((_, k) => `<td${attr(k)}>${inline(r[k] ?? '')}</td>`).join('')}</tr>`)
        .join('');
      html.push(`<div class="kb-table"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`);
      continue;
    }

    // Cita
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      html.push(`<blockquote>${renderMarkdown(body.join('\n'), opts)}</blockquote>`);
      continue;
    }

    // Listas
    const listRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    const li = listRe.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]!);
      const items: string[] = [];
      let current = li[3]!;
      i++;
      while (i < lines.length) {
        const next = lines[i]!;
        const m = listRe.exec(next);
        if (m && /\d/.test(m[2]!) === ordered && m[1]!.length <= li[1]!.length + 1) {
          items.push(current);
          current = m[3]!;
          i++;
        } else if (next.trim() !== '' && /^\s{2,}/.test(next) && !listRe.test(next)) {
          current += ' ' + next.trim(); // continuación del ítem
          i++;
        } else if (m) {
          // sublista: se aplana como texto del ítem anterior
          current += ' · ' + m[3]!;
          i++;
        } else {
          break;
        }
      }
      items.push(current);
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }

    // Párrafo: hasta línea vacía o inicio de otro bloque
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length) {
      const next = lines[i]!;
      if (
        next.trim() === '' ||
        /^(#{1,6})\s/.test(next) ||
        /^\s*(```|~~~)/.test(next) ||
        listRe.test(next) ||
        /^\s*>/.test(next) ||
        (next.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!))
      ) {
        break;
      }
      para.push(next.trim());
      i++;
    }
    html.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return html.join('\n');
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Quita el primer `# Título` del documento (la página lo pinta aparte). */
export function stripLeadingH1(src: string): { title: string | null; body: string } {
  const m = /^\s*#\s+(.+?)\s*#*\s*\n/.exec(src.replace(/\r\n?/g, '\n') + '\n');
  if (!m) return { title: null, body: src };
  return { title: m[1]!, body: src.replace(/\r\n?/g, '\n').slice(m[0].length) };
}
