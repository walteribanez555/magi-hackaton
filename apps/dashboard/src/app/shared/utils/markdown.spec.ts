import { escapeHtml, isSafeHref, renderMarkdown } from './markdown';

describe('markdown', () => {
  it('escapa HTML crudo', () => {
    const html = renderMarkdown('Hola <script>alert(1)</script> & <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });
  it('descarta enlaces javascript: y data:', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href');
    expect(renderMarkdown('[x](java\tscript:alert(1))')).not.toContain('href');
    expect(isSafeHref('data:text/html,hi')).toBe(false);
    expect(isSafeHref('https://example.com')).toBe(true);
    expect(isSafeHref('tokens.md')).toBe(true);
  });
  it('escapa atributos dentro del href', () => {
    const html = renderMarkdown('[x](https://a.com/"onmouseover="alert(1))');
    expect(html).not.toContain('"onmouseover');
  });
  it('resuelve enlaces relativos de la guía', () => {
    const html = renderMarkdown('ver [tokens](tokens.md)', {
      resolveLink: (h) => (h.endsWith('.md') ? `/guia/${h.replace(/\.md$/, '')}` : null),
    });
    expect(html).toContain('<a href="/guia/tokens">tokens</a>');
  });
  it('renderiza encabezados, listas, tablas y código', () => {
    const html = renderMarkdown(
      '## Qué es\n\n- uno\n- **dos**\n\n| a | b |\n|---|---|\n| `x|y` | 2 |\n\n```\n<b>raw</b>\n```',
    );
    expect(html).toContain('<h2 id="que-es">Qué es</h2>');
    expect(html).toContain('<ul><li>uno</li><li><strong>dos</strong></li></ul>');
    expect(html).toContain('<td><code>x|y</code></td>');
    expect(html).toContain('<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>');
  });
  it('no aplica cursiva dentro de snake_case', () => {
    expect(renderMarkdown('intra_change y repeated_in_session')).not.toContain('<em>');
  });
  it('escapeHtml', () => {
    expect(escapeHtml(`<"'&>`)).toBe('&lt;&quot;&#39;&amp;&gt;');
  });
});
