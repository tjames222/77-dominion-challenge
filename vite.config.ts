import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        login: 'login.html',
        register: 'register.html',
        dashboard: 'dashboard.html',
        todayActions: 'today-actions.html',
        science: 'science.html',
      },
    },
  },
});
