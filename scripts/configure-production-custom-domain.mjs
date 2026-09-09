import { pathToFileURL } from 'node:url';

export const PRODUCTION_DOMAIN_ACCOUNT = '458dff367f845e8295be4cfb1af8633a';
export const PRODUCTION_DOMAIN_PROJECT = '77-dominion-live';
export const PRODUCTION_CUSTOM_DOMAIN = '77dominion.com';
export const PRODUCTION_PAGES_HOST = '77-dominion-live.pages.dev';
const EXISTING_WWW_DOMAIN = 'www.77dominion.com';
const API = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const DOMAIN_STATES = new Set(['initializing', 'pending', 'active']);

class SetupError extends Error {}
const fail = (message) => { throw new SetupError(message); };

function validateOptions(options) {
  const allowed = new Set(['accountId', 'apiToken', 'projectName', 'domain', 'fetchImpl']);
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => !allowed.has(key))) {
    fail('Only the reviewed custom-domain options are supported; host, zone, and target overrides are forbidden.');
  }
  const { accountId, apiToken, projectName = PRODUCTION_DOMAIN_PROJECT,
    domain = PRODUCTION_CUSTOM_DOMAIN, fetchImpl = globalThis.fetch } = options;
  if (accountId !== PRODUCTION_DOMAIN_ACCOUNT) fail('CLOUDFLARE_ACCOUNT_ID must match the reviewed production account.');
  if (projectName !== PRODUCTION_DOMAIN_PROJECT) fail('CLOUDFLARE_PAGES_PROJECT must be exactly 77-dominion-live.');
  if (domain !== PRODUCTION_CUSTOM_DOMAIN) fail('CLOUDFLARE_CUSTOM_DOMAIN must be exactly 77dominion.com.');
  if (typeof apiToken !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/u.test(apiToken)) {
    fail('A valid CLOUDFLARE_API_TOKEN is required.');
  }
  if (typeof fetchImpl !== 'function') fail('A valid HTTP implementation is required.');
  return { apiToken, fetchImpl };
}

async function boundedJson(response, signal) {
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers?.get('content-type') || '')) {
    fail('Cloudflare returned a non-JSON response.');
  }
  const reader = response.body?.getReader?.();
  if (!reader) fail('Cloudflare returned an unreadable response.');
  let bytes = 0;
  const parts = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) fail('Cloudflare response exceeded the bounded size limit.');
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function requireCompleteList(envelope, limit, stage) {
  const rows = envelope.result;
  const info = envelope.result_info;
  if (!Array.isArray(rows) || rows.length > limit || !info || info.page !== 1
    || !Number.isInteger(info.total_count) || info.total_count !== rows.length
    || !Number.isInteger(info.total_pages) || info.total_pages < 0 || info.total_pages > 1) {
    fail(`Cloudflare ${stage} listing is incomplete or ambiguous; no write is permitted.`);
  }
  return rows;
}

function requireDomain(domain, expectedName, zoneId, { active = false } = {}) {
  if (!domain || domain.name !== expectedName || !DOMAIN_STATES.has(domain.status)
    || (active && domain.status !== 'active')
    || (domain.zone_tag && domain.zone_tag !== zoneId)) {
    fail('Cloudflare returned an unexpected or unhealthy Pages domain binding.');
  }
  return domain;
}

function inspectApexRecords(records) {
  if (records.some((record) => !record || record.name !== PRODUCTION_CUSTOM_DOMAIN
    || typeof record.type !== 'string')) {
    fail('Cloudflare DNS response did not contain only the exact reviewed apex.');
  }
  const routing = records.filter((record) => ['A', 'AAAA', 'CNAME', 'NS'].includes(record.type));
  if (routing.length === 0) return null;
  if (routing.length !== 1 || routing[0].type !== 'CNAME'
    || routing[0].content !== PRODUCTION_PAGES_HOST
    || routing[0].proxied !== true || routing[0].ttl !== 1) {
    fail('Conflicting apex DNS exists; no record will be overwritten or deleted.');
  }
  return routing[0];
}

/**
 * Add only the approved apex binding and an absent exact proxied CNAME.
 * References: Cloudflare Pages domains create/get, Zones list, DNS records
 * list/create, and Pages custom-domain documentation. No project, zone,
 * existing DNS record, www binding, setting, or billing plan is changed.
 */
export async function configureProductionCustomDomain(options) {
  const { apiToken, fetchImpl } = validateOptions(options);
  const projectPath = `/accounts/${PRODUCTION_DOMAIN_ACCOUNT}/pages/projects/${PRODUCTION_DOMAIN_PROJECT}`;
  const request = async (path, stage, { method = 'GET', body, allowMissing = false } = {}) => {
    // Every caller supplies a locally constructed pinned path; never follow
    // API-provided URLs or redirects with the production bearer credential.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error', cache: 'no-store', signal: controller.signal,
      });
      if (response?.redirected || (response?.status >= 300 && response?.status < 400)) {
        fail(`Cloudflare ${stage} refused an unexpected redirect.`);
      }
      if (response?.status === 401 || response?.status === 403) {
        fail(`Cloudflare denied ${stage}; check Pages Write, Zone Read, and DNS Read/Write permissions on the reviewed account and zone.`);
      }
      if (allowMissing && response?.status === 404) return null;
      if (response?.ok !== true || response.status < 200 || response.status >= 300) {
        fail(`Cloudflare ${stage} failed; no existing records were modified.`);
      }
      const envelope = await boundedJson(response, controller.signal);
      if (!envelope || envelope.success !== true || !Object.hasOwn(envelope, 'result')) {
        fail(`Cloudflare ${stage} returned an unsuccessful response.`);
      }
      return envelope;
    } catch (error) {
      if (error instanceof SetupError) throw error;
      // Transport and provider error text may echo headers or credentials.
      fail(`Cloudflare ${stage} could not be completed safely; no automatic retry was attempted.`);
    } finally {
      clearTimeout(timer);
      await response?.body?.cancel?.().catch(() => {});
    }
  };

  const project = (await request(projectPath, 'project verification')).result;
  if (!project || project.name !== PRODUCTION_DOMAIN_PROJECT
    || project.subdomain !== PRODUCTION_PAGES_HOST || project.production_branch !== 'main'
    || !Array.isArray(project.domains) || !project.domains.includes(EXISTING_WWW_DOMAIN)) {
    fail('The existing production project and www binding do not match the reviewed target.');
  }
  const zoneQuery = new URLSearchParams({ name: PRODUCTION_CUSTOM_DOMAIN,
    'account.id': PRODUCTION_DOMAIN_ACCOUNT, match: 'all', page: '1', per_page: '50' });
  const zones = requireCompleteList(await request(`/zones?${zoneQuery}`, 'zone verification'), 50, 'zone');
  if (zones.length !== 1 || zones[0].name !== PRODUCTION_CUSTOM_DOMAIN
    || zones[0].account?.id !== PRODUCTION_DOMAIN_ACCOUNT || zones[0].status !== 'active'
    || !/^[a-f0-9]{32}$/u.test(zones[0].id || '')) {
    fail('The apex must already be one active Cloudflare zone in the reviewed production account.');
  }
  const zoneId = zones[0].id;
  requireDomain((await request(`${projectPath}/domains/${EXISTING_WWW_DOMAIN}`, 'existing www verification')).result,
    EXISTING_WWW_DOMAIN, zoneId, { active: true });
  const dnsQuery = new URLSearchParams({ 'name.exact': PRODUCTION_CUSTOM_DOMAIN,
    match: 'all', page: '1', per_page: '100' });
  const dnsPath = `/zones/${zoneId}/dns_records`;
  const readApex = async () => inspectApexRecords(requireCompleteList(
    await request(`${dnsPath}?${dnsQuery}`, 'apex DNS verification'), 100, 'DNS'));

  // Complete the read-only preflight before any association could create DNS.
  let cname = await readApex();
  const existing = await request(`${projectPath}/domains/${PRODUCTION_CUSTOM_DOMAIN}`, 'apex binding verification', { allowMissing: true });
  let domain = existing ? requireDomain(existing.result, PRODUCTION_CUSTOM_DOMAIN, zoneId) : null;
  if (!domain && project.domains.includes(PRODUCTION_CUSTOM_DOMAIN)) {
    fail('Cloudflare apex binding reads disagree; no write is permitted.');
  }
  let domainCreated = false;
  let dnsCreated = false;
  if (!domain) {
    domain = requireDomain((await request(`${projectPath}/domains`, 'apex binding creation', {
      method: 'POST', body: { name: PRODUCTION_CUSTOM_DOMAIN },
    })).result, PRODUCTION_CUSTOM_DOMAIN, zoneId);
    domainCreated = true;
  }
  // Pages may provision its own CNAME when associating an in-account zone.
  // Re-read before POST; never duplicate or overwrite that record.
  cname = await readApex();
  if (!cname) {
    const created = (await request(dnsPath, 'apex DNS creation', { method: 'POST', body: {
      type: 'CNAME', name: PRODUCTION_CUSTOM_DOMAIN, content: PRODUCTION_PAGES_HOST,
      proxied: true, ttl: 1,
    } })).result;
    cname = inspectApexRecords([created]);
    if (!cname) fail('Cloudflare did not confirm the exact requested apex CNAME.');
    dnsCreated = true;
  }
  if (!await readApex()) fail('The apex CNAME was not present during final verification.');
  domain = requireDomain((await request(`${projectPath}/domains/${PRODUCTION_CUSTOM_DOMAIN}`, 'final apex binding verification')).result,
    PRODUCTION_CUSTOM_DOMAIN, zoneId);
  requireDomain((await request(`${projectPath}/domains/${EXISTING_WWW_DOMAIN}`, 'final www verification')).result,
    EXISTING_WWW_DOMAIN, zoneId, { active: true });
  return Object.freeze({ domain: PRODUCTION_CUSTOM_DOMAIN, project: PRODUCTION_DOMAIN_PROJECT,
    domainCreated, dnsCreated, domainStatus: domain.status, dnsVerified: true,
    existingWwwVerified: true, activationPending: domain.status !== 'active' });
}

export function productionCustomDomainOptions(env = process.env) {
  for (const name of ['CLOUDFLARE_API_ORIGIN', 'CLOUDFLARE_API_BASE_URL', 'CLOUDFLARE_API_HOST', 'CLOUDFLARE_ZONE_ID']) {
    if (env[name]) fail('Cloudflare host and zone overrides are forbidden.');
  }
  return { accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN,
    projectName: env.CLOUDFLARE_PAGES_PROJECT ?? PRODUCTION_DOMAIN_PROJECT,
    domain: env.CLOUDFLARE_CUSTOM_DOMAIN ?? PRODUCTION_CUSTOM_DOMAIN };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) fail('This helper accepts no command-line arguments.');
    console.log(JSON.stringify(await configureProductionCustomDomain(productionCustomDomainOptions())));
  } catch (error) {
    console.error(error instanceof SetupError ? error.message : 'Custom-domain setup failed safely.');
    process.exitCode = 1;
  }
}
