<script>
import { api } from '../store';
import { parseMarkdown, safeHref } from '../markdown';

/** 需要按块级元素渲染的 token，其余在列表项里当行内内容处理。 */
const BLOCK_TYPES = ['paragraph', 'heading', 'code', 'blockquote', 'table', 'hr'];

export default {
  name: 'AiMarkdown',
  props: {
    text: { type: String, default: '' },
  },
  computed: {
    tokens() {
      return parseMarkdown(this.text);
    },
  },
  render(h) {
    return h('div', { class: 'md' }, this.blocks(h, this.tokens));
  },
  methods: {
    blocks(h, list) {
      return (list || []).map((token, i) => this.block(h, token, i));
    },
    block(h, token, key) {
      const children = () => this.inline(h, token.tokens || [{ type: 'text', text: token.text }]);
      switch (token.type) {
        case 'paragraph':
          return h('p', { key, class: 'md-p' }, children());
        case 'heading': {
          const depth = Math.min(Math.max(token.depth || 1, 1), 6);
          return h('h' + depth, { key, class: ['md-h', 'md-h' + depth] }, children());
        }
        case 'code':
          return h('pre', { key, class: 'md-code' }, token.text);
        case 'blockquote':
          return h('blockquote', { key, class: 'md-quote' }, this.blocks(h, token.tokens));
        case 'list':
          return this.list(h, token, key);
        case 'table':
          return this.table(h, token, key);
        case 'hr':
          return h('hr', { key, class: 'md-hr' });
        // 模型直接写出的 html 与未识别类型一律当纯文本插值，不解析成元素
        default:
          return h('p', { key, class: 'md-p' }, this.textOf(token));
      }
    },
    list(h, token, key) {
      const attrs = token.ordered && token.start > 1 ? { start: String(token.start) } : {};
      return h(token.ordered ? 'ol' : 'ul', { key, class: ['md-list', token.ordered ? 'md-list-ol' : null], attrs },
        (token.items || []).map((item, i) => this.listItem(h, item, i)));
    },
    listItem(h, item, key) {
      const kids = [];
      for (const token of item.tokens || []) {
        if (token.type === 'space') continue;
        if (token.type === 'list') kids.push(this.list(h, token, 'l' + key + kids.length));
        else if (token.type === 'text') kids.push(...this.inline(h, token.tokens || [{ type: 'text', text: token.text }]));
        else if (BLOCK_TYPES.includes(token.type)) kids.push(this.block(h, token, 'b' + key + kids.length));
        else kids.push(...this.inline(h, [token]));
      }
      return h('li', { key }, kids);
    },
    table(h, token, key) {
      const cells = (row, tag) =>
        (row || []).map((cell, i) =>
          h(tag, {
            key: i,
            style: token.align && token.align[i] ? { textAlign: token.align[i] } : null,
          }, this.inline(h, cell.tokens || [{ type: 'text', text: cell.text }]))
        );
      return h('table', { key, class: 'md-table' }, [
        h('thead', [h('tr', cells(token.header, 'th'))]),
        h('tbody', (token.rows || []).map((row, r) => h('tr', { key: r }, cells(row, 'td')))),
      ]);
    },
    inline(h, list) {
      return (list || []).map((token, i) => this.inlineToken(h, token, i));
    },
    inlineToken(h, token, key) {
      const children = () => this.inline(h, token.tokens || [{ type: 'text', text: token.text }]);
      switch (token.type) {
        case 'strong':
          return h('b', { key }, children());
        case 'em':
          return h('em', { key }, children());
        case 'del':
          return h('s', { key }, children());
        case 'codespan':
          return h('code', { key, class: 'md-i-code' }, token.text);
        case 'br':
          return h('br', { key });
        case 'checkbox':
          return h('span', { key, class: ['md-box', token.checked ? 'is-checked' : null] });
        case 'link':
          return safeHref(token.href) ? this.link(h, key, token.href, children()) : h('span', { key }, children());
        // 面板里不为模型给的图片发起网络请求，退化成可点击的文字
        case 'image':
          return safeHref(token.href) ? this.link(h, key, token.href, [token.text || token.href]) : h('span', { key }, token.text || '');
        default:
          return h('span', { key }, this.textOf(token));
      }
    },
    link(h, key, href, children) {
      const url = safeHref(href);
      return h('a', {
        key,
        class: 'md-link',
        on: {
          click: (e) => {
            e.preventDefault();
            if (api.openExternal) api.openExternal(url);
          },
        },
      }, children);
    },
    textOf(token) {
      return typeof token.text === 'string' ? token.text : '';
    },
  },
};
</script>

<style scoped>
.md {
  display: block;
}
.md-p {
  margin: 0 0 6px;
  line-height: 1.7;
  word-break: break-word;
}
.md-p:last-child {
  margin-bottom: 0;
}
.md-h {
  margin: 8px 0 5px;
  font-weight: 700;
  line-height: 1.6;
}
.md-h1 {
  font-size: 14.5px;
}
.md-h2 {
  font-size: 13.5px;
}
.md-h3,
.md-h4,
.md-h5,
.md-h6 {
  font-size: 12.5px;
}
.md:first-child .md-h:first-child {
  margin-top: 0;
}
.md-list {
  margin: 0 0 6px;
  padding-left: 20px;
  line-height: 1.7;
}
.md-list li {
  margin: 1px 0;
}
.md-list li > .md-p {
  margin: 0;
}
.md-quote {
  margin: 0 0 6px;
  padding: 2px 0 2px 10px;
  border-left: 2px solid var(--border);
  color: var(--text-2);
  line-height: 1.7;
}
.md-hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 8px 0;
}
.md-code {
  margin: 0 0 7px;
  padding: 7px 9px;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: Consolas, "Courier New", monospace;
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre;
  overflow-x: auto;
  color: var(--text);
}
.md-code::-webkit-scrollbar {
  height: 6px;
}
.md-code::-webkit-scrollbar-track {
  background: transparent;
}
.md-code::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 3px;
}
.md-code::-webkit-scrollbar-thumb:hover {
  background: var(--text-3);
}
.md-table {
  width: 100%;
  margin: 0 0 7px;
  border-collapse: collapse;
  font-size: 11.5px;
  table-layout: auto;
}
.md-table th,
.md-table td {
  padding: 3px 7px;
  border: 1px solid var(--border);
  text-align: left;
  word-break: break-word;
}
.md-table th {
  background: var(--bg-app);
  font-weight: 700;
  color: var(--text-2);
}
.md-box {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 5px;
  border: 1px solid var(--text-3);
  border-radius: 2px;
  vertical-align: -1px;
}
.md-box.is-checked {
  background: var(--accent);
  border-color: var(--accent);
}
.md b {
  font-weight: 700;
}
.md em {
  font-style: italic;
}
.md s {
  text-decoration: line-through;
  color: var(--text-2);
}
.md code.md-i-code {
  font-family: Consolas, "Courier New", monospace;
  font-size: 11.5px;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  white-space: pre-wrap;
}
.md a.md-link {
  color: var(--accent);
  text-decoration: none;
  cursor: pointer;
}
.md a.md-link:hover {
  text-decoration: underline;
}
</style>
