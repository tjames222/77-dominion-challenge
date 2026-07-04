import { createApp } from 'vue';
import App from './App.vue';
import './assets/styles.css';
import { initReveal } from './static/reveal';

createApp(App).mount('#app');
requestAnimationFrame(() => initReveal());
