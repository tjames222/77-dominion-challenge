import base from '../playwright.config.mjs';
import { fileURLToPath } from 'node:url';

// Diagnostic only: use the real project's browser/fixture/server settings.
const root = fileURLToPath(new URL('../', import.meta.url));
const project = base.projects.find((entry) => entry.name === 'webkit-badges-mobile');
export default {
  ...base,
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: /preview-badge-observer\.spec\.mjs/,
  outputDir: fileURLToPath(new URL('../test-results/preview-badge-observer', import.meta.url)),
  webServer: base.webServer ? { ...base.webServer, cwd: root } : undefined,
  projects: [{ ...project, testMatch: /preview-badge-observer\.spec\.mjs/ }],
};
