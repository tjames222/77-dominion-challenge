import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const dominionNightEnabled = env.VITE_ENABLE_DOMINION_NIGHT_THEME === 'true';

  return {
    base: './',
    plugins: [
      {
        name: 'dominion-theme-feature-flags',
        enforce: 'pre',
        transformIndexHtml(html) {
          return html.replaceAll(
            'data-enable-dominion-night="false"',
            `data-enable-dominion-night="${String(dominionNightEnabled)}"`,
          );
        },
      },
      vue(),
    ],
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
          badgesRewards: 'badges-rewards.html',
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
  };
});
