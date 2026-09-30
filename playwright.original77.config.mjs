import base from './playwright.app-streak.config.mjs';
const output = `/tmp/77dc-original77-dist-${process.pid}`;
export default {
  ...base,
  testMatch: /original77-live\.spec\.mjs/,
  outputDir: './test-results/original77',
  webServer: { ...base.webServer,
    command: base.webServer.command.replaceAll(/\/tmp\/77dc-app-streak-dist-\d+/g, output) },
};
