/** Lightweight i18n — components re-read translations when store.localeTick changes */

import { UI_FONTS } from './constants';
import zhLocale from 'element-plus/es/locale/lang/zh-cn';
import enLocale from 'element-plus/es/locale/lang/en';

import zh from './locales/zh';
import en from './locales/en';

const dict = { zh, en };

export const i18n = {
  locale: 'zh',
};

export function setLocale(locale) {
  i18n.locale = locale === 'en' ? 'en' : 'zh';
  document.documentElement.lang = i18n.locale === 'zh' ? 'zh-CN' : 'en';
}

/** Element Plus 内置文案（分页、表格空态、日期控件）由根部的 el-config-provider 消费。 */
export function elementLocale() {
  return i18n.locale === 'en' ? enLocale : zhLocale;
}

export function t(key, params) {
  const table = dict[i18n.locale] || dict.zh;
  let s = table[key] != null ? table[key] : dict.zh[key] != null ? dict.zh[key] : key;
  if (params) {
    Object.keys(params).forEach((k) => {
      s = s.split('{' + k + '}').join(params[k]);
    });
  }
  return s;
}

/** now 由调用方传入：列表想按分钟自己推进时，得让参考时刻是响应式的 */
export function formatTime(ts, now) {
  if (!ts) return '';
  const diff = (now || Date.now()) - ts;
  if (diff < 60000) return t('time.justNow');
  if (diff < 3600000) return t('time.minutesAgo', { n: Math.floor(diff / 60000) });
  if (diff < 86400000) return t('time.hoursAgo', { n: Math.floor(diff / 3600000) });
  if (diff < 2592000000) return t('time.daysAgo', { n: Math.floor(diff / 86400000) });
  return t('time.earlier');
}

export function applyTheme(theme) {
  const light =
    theme === 'light' ||
    (theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.classList.toggle('theme-light', !!light);
  // also set class on #app parent for scoped rules if needed
  const app = document.getElementById('app');
  if (app) app.classList.toggle('theme-light', !!light);
}

export function applyFont(font) {
  const hit = UI_FONTS.find((f) => f.id === font);
  if (hit && hit.family) document.documentElement.style.setProperty('--app-font', hit.family);
  else document.documentElement.style.removeProperty('--app-font');
}

export function applySettings(settings) {
  if (!settings) return;
  applyTheme(settings.theme || 'system');
  setLocale(settings.lang || 'zh');
  applyFont(settings.font || 'default');
  // In Electron the main process owns real zoom; CSS zoom only approximates it in browser preview
  if (!window.novoTerminal) {
    const z = Number(settings.zoom) || 100;
    document.documentElement.style.zoom = z === 100 ? '' : String(z / 100);
  }
}
