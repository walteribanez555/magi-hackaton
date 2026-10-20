import { describe, expect, it } from 'vitest';
import { inlineToAdf, markdownToAdf } from '../adf';

describe('markdownToAdf', () => {
  it('párrafos, negrita, código y enlaces', () => {
    expect(markdownToAdf('Desplegado **9f8e7d6c5b4a** en `production`.\nVer [PR #42](https://github.com/acme/shop/pull/42)\n\nSegundo párrafo')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Desplegado ' },
            { type: 'text', text: '9f8e7d6c5b4a', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' en ' },
            { type: 'text', text: 'production', marks: [{ type: 'code' }] },
            { type: 'text', text: '.' },
            { type: 'hardBreak' },
            { type: 'text', text: 'Ver ' },
            { type: 'text', text: 'PR #42', marks: [{ type: 'link', attrs: { href: 'https://github.com/acme/shop/pull/42' } }] },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Segundo párrafo' }] },
      ],
    });
  });

  it('listas con viñetas y URL suelta (sin el punto final)', () => {
    const doc = markdownToAdf('Cambios:\n- tokens: **1,500**\n* líneas efectivas: 27.5\n\nhttps://dash.example.com/tasks/MAG-1.');
    expect(doc.content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Cambios:' }] });
    expect(doc.content[1]).toEqual({
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'tokens: ' }, { type: 'text', text: '1,500', marks: [{ type: 'strong' }] }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'líneas efectivas: 27.5' }] }] },
      ],
    });
    expect(doc.content[2]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'https://dash.example.com/tasks/MAG-1', marks: [{ type: 'link', attrs: { href: 'https://dash.example.com/tasks/MAG-1' } }] },
        { type: 'text', text: '.' },
      ],
    });
  });

  it('bloque de código ``` y texto vacío', () => {
    expect(markdownToAdf('```\nnpm test\n```').content).toEqual([{ type: 'codeBlock', content: [{ type: 'text', text: 'npm test' }] }]);
    expect(markdownToAdf('   ').content).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: ' ' }] }]);
  });

  it('no genera nodos de texto vacíos ni enlaces javascript:', () => {
    expect(inlineToAdf('**a**`b`')).toEqual([
      { type: 'text', text: 'a', marks: [{ type: 'strong' }] },
      { type: 'text', text: 'b', marks: [{ type: 'code' }] },
    ]);
    expect(inlineToAdf('[x](javascript:alert(1))')).toEqual([{ type: 'text', text: '[x](javascript:alert(1))' }]);
  });
});
