import { describe, it, expect } from 'vitest';
import { parseMarkdown, safeHref } from './markdown';

describe('parseMarkdown', () => {
  it('空文本返回空 token 列表', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('   ')).toEqual([]);
    expect(parseMarkdown(null)).toEqual([]);
  });

  it('过滤 space 与 def，其余保持顺序', () => {
    const tokens = parseMarkdown('# 标题\n\n正文');
    expect(tokens.map((x) => x.type)).toEqual(['heading', 'paragraph']);
  });

  it('只有链接定义时没有可见 token', () => {
    expect(parseMarkdown('[ref]: https://example.com')).toEqual([]);
  });

  it('保持代码块原始内容', () => {
    const tokens = parseMarkdown('```js\nconst a = 1;\n```');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('code');
    expect(tokens[0].text).toBe('const a = 1;');
  });
});

describe('safeHref', () => {
  it('只放行 http/https', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('HTTP://example.com')).toBe('HTTP://example.com');
    expect(safeHref(' http://example.com ')).toBe('http://example.com');
  });

  it('其余协议与空值返回空串', () => {
    expect(safeHref('javascript:alert(1)')).toBe('');
    expect(safeHref('mailto:a@b.c')).toBe('');
    expect(safeHref('')).toBe('');
    expect(safeHref(null)).toBe('');
  });
});
