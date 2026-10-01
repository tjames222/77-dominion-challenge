import base from './playwright.app-streak.config.mjs';
const port = Number(process.env.E2E_REWARD_PROGRESSION_PORT || 4891);
const baseURL = `http://127.0.0.1:${port}`;
const output = `/tmp/77dc-reward-progression-dist-${port}`;
export default { ...base, testMatch: /reward-progression-live\.spec\.mjs/,
  outputDir: './test-results/reward-progression', use: { ...base.use, baseURL },
  webServer: { ...base.webServer, command: `pnpm exec vite build --outDir ${output} && pnpm exec vite preview --outDir ${output} --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${baseURL}/science.html`, env: { ...base.webServer.env, VITE_SUPABASE_URL: `${baseURL}/__admin_fixture__` } },
};
