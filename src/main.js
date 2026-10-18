import Vue from 'vue';
import ElementUI from 'element-ui';
import 'element-ui/lib/theme-chalk/index.css';
import App from './App.vue';
import SvgIcon from './components/common/SvgIcon.vue';
import { refresh, store, api } from './store';
import { t, applySettings } from './i18n';
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

// Element UI 的 el-radio 把原生 input 硬编码成 aria-hidden="true"，但点击 label 时浏览器会把焦点落到
// 这个 input 上，Chrome 会拦截并打印 “Blocked aria-hidden … descendant retained focus”。摘掉这条错误
// 属性即可，组件本身仍是 tabindex="-1" 且视觉隐藏，交互与外观不变。
function stripRadioAriaHidden(root) {
  const nodes = root.querySelectorAll ? root.querySelectorAll('.el-radio__original[aria-hidden]') : [];
  for (const node of nodes) node.removeAttribute('aria-hidden');
}
stripRadioAriaHidden(document);
new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches('.el-radio__original')) node.removeAttribute('aria-hidden');
      else stripRadioAriaHidden(node);
    }
  }
}).observe(document.body, { childList: true, subtree: true });

Vue.config.productionTip = false;
// 生产构建里组件渲染/钩子异常只进 console，不落盘；转发后界面白屏类问题可从日志回溯
Vue.config.errorHandler = (err, vm, info) => {
  forwardError((err && err.message) || String(err), { vueInfo: info, component: (vm && vm.$options && vm.$options.name) || '' });
};
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
    new Vue({
      render: (h) => h(App),
    }).$mount('#app');
  });
