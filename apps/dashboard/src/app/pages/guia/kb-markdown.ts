/**
 * Render de artículos de la guía: Markdown → HTML seguro.
 *
 * Todo el texto se escapa antes de envolverse en etiquetas generadas (ver shared/utils/markdown.ts);
 * aquí solo se añade la resolución de enlaces entre artículos: `tokens.md` → `/guia/tokens`.
 * El HTML resultante se enlaza con [innerHTML], así que el sanitizador de Angular vuelve a filtrarlo.
 */
import { renderMarkdown, stripLeadingH1 } from '@/shared/utils/markdown';

export { escapeHtml, isSafeHref } from '@/shared/utils/markdown';

export interface KbLinkTarget {
  id: string;
  file: string;
}

/** Construye un resolvedor de enlaces relativos a otros artículos de /kb. */
export function kbLinkResolver(articles: readonly KbLinkTarget[]): (href: string) => string | null {
  const byFile = new Map<string, string>();
  for (const a of articles) {
    byFile.set(a.file.toLowerCase(), a.id);
    byFile.set(a.file.replace(/\.md$/i, '').toLowerCase(), a.id);
  }
  const ids = new Set(articles.map((a) => a.id));
  return (href: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return null;
    const [pathPart, hash] = href.split('#', 2) as [string, string | undefined];
    const path = pathPart.replace(/^\.\//, '').replace(/^\/?kb\//, '');
    if (!path || path.includes('/')) return null;
    const id = byFile.get(path.toLowerCase()) ?? (ids.has(path) ? path : null);
    if (!id) return null;
    return `/guia/${encodeURIComponent(id)}${hash ? '#' + encodeURIComponent(hash) : ''}`;
  };
}

export interface RenderedKbArticle {
  /** Título del primer `# …` (texto plano, sin escapar: se interpola con {{ }}). */
  title: string | null;
  /** HTML seguro del cuerpo. */
  html: string;
}

export function renderKbArticle(markdown: string, articles: readonly KbLinkTarget[]): RenderedKbArticle {
  const { title, body } = stripLeadingH1(markdown);
  return {
    title: title ? title.replace(/[*_`]/g, '') : null,
    html: renderMarkdown(body, { resolveLink: kbLinkResolver(articles) }),
  };
}
