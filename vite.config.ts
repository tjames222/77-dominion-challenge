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
        billing: 'billing.html',
        dashboard: 'dashboard.html',
        todayActions: 'today-actions.html',
        bibleReading: 'bible-reading.html',
        morningPrayer: 'morning-prayer.html',
        worship: 'worship.html',
        eveningPrayer: 'evening-prayer.html',
        workoutOne: 'workout-one.html',
        intentionalWalk: 'intentional-walk.html',
        workoutTwo: 'workout-two.html',
        community: 'community.html',
        profilePage: 'profile.html',
        science: 'science.html',
      },
    },
  },
});
