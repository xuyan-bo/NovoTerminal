import * as ElementIcons from '@element-plus/icons-vue';

/** Element Plus 图标组件全集：main.js 按名字全局注册，数据字段里的图标名也据此判别。 */
export const ELEMENT_ICONS = { ...ElementIcons };

const ELEMENT_ICON_NAMES = new Set(Object.keys(ELEMENT_ICONS));

/** 数据里的图标字段可能存 Element Plus 组件名，也可能存 public/icons 里的自有 SVG 名。 */
export function isElementIcon(name) {
  return typeof name === 'string' && ELEMENT_ICON_NAMES.has(name);
}
