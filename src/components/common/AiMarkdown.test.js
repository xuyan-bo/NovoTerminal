/**
 * AiMarkdown 是纯 render 函数组件，AI 面板的正文全靠它出字。
 * 这里用 SSR 把它渲染成字符串：只要 render 的 h 用错（例如迁回 Vue 2 的 render(h) 写法），
 * 组件会渲染成空标签而不报错，正文就在界面上静默消失——正是这个测试要盯住的东西。
 */
import { describe, it, expect } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import AiMarkdown from './AiMarkdown.vue';

/** scoped 样式会给每个元素加 data-v-xxx，断言只关心结构，先抹掉。 */
const render = async (text) =>
  (await renderToString(createSSRApp({ render: () => h(AiMarkdown, { text }) })))
    .replace(/ data-v-[0-9a-z]+/g, '');

describe('AiMarkdown', () => {
  it('段落与行内强调', async () => {
    const html = await render('你好，**世界**');
    expect(html).toContain('<p class="md-p">');
    expect(html).toContain('<b><span>世界</span></b>');
    expect(html).toContain('你好，');
  });

  it('代码块保留原文', async () => {
    expect(await render('```\nls -l\n```')).toContain('<pre class="md-code">ls -l</pre>');
  });

  it('有序列表带 start 属性', async () => {
    const html = await render('3. 三\n4. 四');
    expect(html).toContain('<ol');
    expect(html).toContain('start="3"');
    expect(html).not.toContain('[object Object]');
  });

  it('链接只放行 http(s)', async () => {
    expect(await render('[文档](https://example.com/a)')).toContain('<a class="md-link"><span>文档</span></a>');
    const bad = await render('[坏链](javascript:alert(1))');
    expect(bad).not.toContain('md-link');
    expect(bad).toContain('坏链');
  });

  it('空文本渲染空容器', async () => {
    expect(await render('')).toBe('<div class="md"></div>');
  });
});
