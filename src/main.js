import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import App from './App.vue';
import SvgIcon from './components/common/SvgIcon.vue';
import { ELEMENT_ICONS } from './lib/icons';
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

const app = createApp(App);
app.use(ElementPlus);
app.component('svg-icon', SvgIcon);
// 图标按名字全局注册：模板里直接写 <el-icon><Close /></el-icon>，数据里的图标字段也按名字渲染
for (const [name, icon] of Object.entries(ELEMENT_ICONS)) {
  app.component(name, icon);
}
// 生产构建里组件渲染/钩子异常只进 console，不落盘；转发后界面白屏类问题可从日志回溯
app.config.errorHandler = (err, instance, info) => {
  forwardError((err && err.message) || String(err), {
    vueInfo: info,
    component: (instance && instance.$options && instance.$options.name) || '',
  });
};
app.config.globalProperties.$t = function (key, params) {
  // touch localeTick so computed re-render
  void store.localeTick;
  return t(key, params);
};

refresh()
  .catch(() => {})
  .finally(() => {
    const s = store.snapshot.settings || {};
    applySettings(s);
    app.mount('#app');

    const boot = document.getElementById('boot');
    if (boot) {
      boot.classList.add('boot-out');
      setTimeout(() => boot.remove(), 280);
    }
    requestAnimationFrame(() => {
      const root = document.getElementById('app');
      if (root) {
        root.classList.remove('boot-enter');
        // index.html 里内联的 opacity:0 只负责首帧拦截，这里交还给样式表
        root.style.opacity = '';
      }
    });
  });
