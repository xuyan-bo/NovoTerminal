/**
 * AI 回复的 markdown 解析：只做词法，不生成 HTML。
 *
 * marked 的 lexer 给出 token 树，AiMarkdown 用 render 函数把它变成真实元素，
 * 所以模型输出里的 `<script>`、`javascript:` 链接没有机会进入 innerHTML。
 */

import { lexer } from 'marked';

export function parseMarkdown(text) {
  const src = String(text == null ? '' : text);
  if (!src.trim()) return [];
  // space 只是分隔，def 是链接引用定义，两者都不该变成可见内容
  return lexer(src).filter((token) => token.type !== 'space' && token.type !== 'def');
}

/** 只放行 http(s)，其余链接按普通文本渲染。 */
export function safeHref(href) {
  const url = String(href || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}
