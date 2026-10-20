import { kbLinkResolver, renderKbArticle } from './kb-markdown';

const articles = [
  { id: 'tokens', file: 'tokens.md' },
  { id: 'inicio', file: 'README.md' },
];

describe('renderKbArticle', () => {
  it('escapa <script> y HTML crudo', () => {
    const { html } = renderKbArticle('# T\n\nHola <script>alert(1)</script> <img src=x onerror=alert(1)>', articles);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapa HTML dentro de código y tablas', () => {
    const { html } = renderKbArticle('```\n<b>x</b>\n```\n\n| a | b |\n|---|---|\n| <i>1</i> | `<u>` |', articles);
    expect(html).not.toMatch(/<b>|<i>|<u>/);
    expect(html).toContain('<table>');
  });

  it('enlaza artículos relativos a /guia/<id> y externos con rel', () => {
    const { html } = renderKbArticle('Ver [tokens](tokens.md), [inicio](./README.md) y [web](https://example.com).', articles);
    expect(html).toContain('href="/guia/tokens"');
    expect(html).toContain('href="/guia/inicio"');
    expect(html).toContain('href="https://example.com" target="_blank" rel="noopener noreferrer"');
  });

  it('descarta javascript: en enlaces', () => {
    const { html } = renderKbArticle('[x](javascript:alert(1))', articles);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a');
  });

  it('separa el título del primer h1', () => {
    expect(renderKbArticle('# Redundancia\n\nTexto', articles).title).toBe('Redundancia');
  });
});

describe('kbLinkResolver', () => {
  it('ignora rutas con carpetas y archivos desconocidos', () => {
    const r = kbLinkResolver(articles);
    expect(r('ml/README.md')).toBeNull();
    expect(r('otro.md')).toBeNull();
    expect(r('tokens.md#total')).toBe('/guia/tokens#total');
  });
});
