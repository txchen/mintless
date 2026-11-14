import { createApp, watch } from 'vue';
import App from './App.vue';
import { applyTheme, resolvedTheme } from './lib/theme.ts';
import { router } from './router.ts';
import './styles.css';

watch(resolvedTheme, applyTheme, { immediate: true });

createApp(App).use(router).mount('#app');
