import Vue from 'vue';
import ElementUI from 'element-ui';
import zhLocale from 'element-ui/lib/locale/lang/zh-CN';
import enLocale from 'element-ui/lib/locale/lang/en';
import locale from 'element-ui/lib/locale';
import 'element-ui/lib/theme-chalk/index.css';
import App from './App.vue';
import SvgIcon from './components/SvgIcon.vue';
import { refresh, store, api } from './store';
import { t, setLocale, applySettings } from './i18n';
import './styles/main.css';

/** Forward uncaught renderer errors to the main-process log sink (no-op in browser). */
function forwardError(message, meta) {
  try {
    if (api && api.logWrite) {
      api.logWrite({ level: 'error', source: 'renderer', message, meta });
    }
  } catch (_) {}
}
window.addEventListener('error', (e) => {
  forwardError(e.message || 'uncaught error', { file: e.filename, line: e.lineno, col: e.colno });
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  forwardError((r && (r.message || r)) || String(r), { rejected: true });
});

Vue.use(ElementUI, { size: 'small' });
Vue.component('svg-icon', SvgIcon);
Vue.config.productionTip = false;
Vue.prototype.$t = function (key, params) {
  // touch localeTick so computed re-render
  void store.localeTick;
  return t(key, params);
};

refresh()
  .catch(() => {})
  .finally(() => {
    const s = store.snapshot.settings || {};
    applySettings(s);
    locale.use(s.lang === 'en' ? enLocale : zhLocale);
    new Vue({
      render: (h) => h(App),
    }).$mount('#app');
  });
