import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        membership: 'membership.html',
        login: 'login.html',
        register: 'register.html',
        invite: 'invite.html',
        billing: 'billing.html',
        dashboard: 'dashboard.html',
        todayActions: 'today-actions.html',
        community: 'community.html',
        profilePage: 'profile.html',
        science: 'science.html',
      },
    },
  },
});
