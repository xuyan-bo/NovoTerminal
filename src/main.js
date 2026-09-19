import Vue from 'vue';
import ElementUI from 'element-ui';
import zhLocale from 'element-ui/lib/locale/lang/zh-CN';
import enLocale from 'element-ui/lib/locale/lang/en';
import locale from 'element-ui/lib/locale';
import 'element-ui/lib/theme-chalk/index.css';
import App from './App.vue';
import { refresh, store } from './store';
import { t, setLocale, applySettings } from './i18n';
import './styles/main.css';

Vue.use(ElementUI, { size: 'small' });
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
