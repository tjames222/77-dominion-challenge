import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const exports = new Set();
for (const file of ['community.js', 'group-settings.js', 'crew-invite-dialog.js']) {
  const source = readFileSync(`${root}/src/static/${file}`, 'utf8');
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/api(?:\.js)?['"]/g)) {
    for (const name of match[1].split(',').map(value => value.trim()).filter(Boolean)) exports.add(name);
  }
}

// Compile the real route and all UI helpers. Only the pre-existing API facade
// is replaced with a local fixture: no SDK, credentials, remote providers or
// hosted data are involved. This supplements the full 29-route graph tests.
export async function createIntegrationBuildHarness(flag) {
  const scripts = new Map();
  for (const route of ['community', 'group-settings']) {
    const artifact = await build({ root, configFile: false, envDir: false, logLevel: 'silent',
      define: { 'import.meta.env.VITE_ENABLE_GROUP_INTEGRATIONS': JSON.stringify(flag) },
      plugins: [{ name: 'isolated-group-integration-api', enforce: 'pre',
        resolveId(id) { if (id === './api' || id === './api.js') return '\0integration-api-fixture'; },
        load(id) { if (id === '\0integration-api-fixture') return [...exports].map(name =>
          `export const ${name} = (...args) => window.__integrationFixture.call(${JSON.stringify(name)}, args);`).join('\n'); },
      }],
      build: { write: false, lib: { entry: `${root}/src/static/${route}.js`, name: 'IntegrationRoute', formats: ['iife'] } },
    });
    const chunks = [artifact].flat().flatMap(bundle => bundle.output).filter(asset => asset.type === 'chunk');
    if (chunks.length !== 1) throw new Error('The isolated route fixture must be one compiled script.');
    scripts.set(route, chunks[0].code);
  }
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const route = pathname.slice(1).replace(/\.(html|js)$/, '');
    if (!scripts.has(route)) { response.writeHead(404); response.end(); return; }
    if (pathname.endsWith('.js')) {
      response.setHeader('Content-Type', 'text/javascript'); response.end(scripts.get(route)); return;
    }
    const html = readFileSync(`${root}/${route}.html`, 'utf8')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<link\b[^>]*>/gi, '')
      // Real dialog positioning is required for native pointer confirmation;
      // do not force clicks or invent test-only dialog geometry.
      .replace('</head>', `<style>${readFileSync(`${root}/src/assets/dialog.css`, 'utf8')}</style></head>`)
      .replace('</body>', `<script src="/${route}.js"></script></body>`);
    response.setHeader('Content-Type', 'text/html'); response.end(html);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}

export async function installIntegrationFixture(page, { role = 'owner', provider = 'slack' } = {}) {
  await page.addInitScript(({ role, provider }) => {
    const crew = { id: 'synthetic-crew', role, name: 'Synthetic Group', challengeStartDate: '2026-01-01' };
    let destinations = [];
    let consent = { consentRecorded: false, outboundUpdatesEnabled: false, presentationMode: 'anonymous', events: {} };
    const calls = [];
    const fixture = window.__integrationFixture = { calls, call(name, args) {
      calls.push({ name, args });
      if (name === 'subscribeToAuthStateChanges') return () => {};
      if (name === 'hasSupabaseAuth') return true;
      if (name === 'isLocalDemoMode') return false;
      if (name === 'getBillingState') return Promise.resolve({ authenticated: true, appAccess: true });
      if (name === 'getLocalOrSessionUser') return Promise.resolve({ authenticated: true, userId: 'synthetic-owner' });
      if (name === 'getCrews') return Promise.resolve([crew]);
      if (name === 'getCrewMembers' || name === 'getLeaderboard') return Promise.resolve([]);
      if (name === 'getCrewTrainingProgress' || name === 'getChallengeActivation') return Promise.resolve(null);
      if (name === 'getOutboundUpdateConsent') return Promise.resolve(consent);
      if (name === 'getOutboundIntegrationDestinations') return Promise.resolve([]);
      if (name === 'updateOutboundUpdateConsent') {
        consent = { ...args[1], consentRecorded: true }; return Promise.resolve(consent);
      }
      if (name === 'manageGroupIntegration') {
        const [action, values] = args;
        if (action === 'list') return Promise.resolve({ destinations });
        if (action === 'channels') return Promise.resolve({ provider, crewId: crew.id,
          workspace: { name: 'Synthetic workspace' }, channels: [{ id: 'synthetic-channel', name: 'practice' }] });
        if (action === 'confirm') {
          destinations = [{ id: 'synthetic-destination', crewId: crew.id, provider, canManage: role === 'owner',
            status: 'active', workspaceName: 'Synthetic workspace', channelName: 'practice',
            checkInsEnabled: true, recapCadence: 'off' }];
          return Promise.resolve({ destination: destinations[0] });
        }
        if (action === 'configure') { Object.assign(destinations[0], values); return Promise.resolve({}); }
        if (action === 'test') return Promise.resolve({ delivered: true });
        if (action === 'disconnect') { destinations = []; return Promise.resolve({}); }
        // Invalid synthetic authorization must be rejected locally, never
        // followed. Testing real provider redirects is outside this scope.
        if (action === 'begin') return Promise.resolve({ authorizationUrl: 'https://not-a-provider.invalid/authorize' });
      }
      throw new Error(`Unexpected synthetic API call: ${name}`);
    } };
    fixture.network = [];
    window.fetch = (...args) => { fixture.network.push(String(args[0])); return Promise.reject(new Error('Network forbidden in isolated UI fixture')); };
  }, { role, provider });
}
