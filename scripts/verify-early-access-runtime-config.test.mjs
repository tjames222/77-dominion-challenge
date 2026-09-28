import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { diagnoseEarlyAccessRuntimeConfig, EARLY_ACCESS_RUNTIME_DIAGNOSTIC_LABELS, verifyEarlyAccessRuntimeConfig } from './verify-early-access-runtime-config.mjs';
const config = () => ({
  SUPABASE_PROJECT_REF: 'mimolwojppbtsbvtqwpo', BILLING_ENABLED: 'false',
  TRANSACTIONAL_EMAIL_FROM: 'Dominion <noreply@mail.77dominion.com>',
  EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED: 'true', EARLY_ACCESS_AUTH_RECOVERY_TTL_SECONDS: '3600',
  RESEND_API_KEY: 're_fixture', LINEAR_FEEDBACK_API_KEY: 'lin_api_' + 'l'.repeat(40),
  EARLY_ACCESS_INVITATION_KEY: Buffer.alloc(32, 3).toString('base64url'), EARLY_ACCESS_INVITATION_KEY_VERSION: '1',
  FEEDBACK_WORKER_SECRET: 'f'.repeat(43), EARLY_ACCESS_INVITATION_WORKER_SECRET: 'i'.repeat(43),
});
const rejected = value => assert.throws(() => verifyEarlyAccessRuntimeConfig(value), error => error.message === 'Early Access production runtime configuration is incomplete or unsafe.');
test('runtime settings validate fixed project/free mode and only return safe receipt', () => { assert.equal(verifyEarlyAccessRuntimeConfig(config()), true); });
test('runtime settings require every field and exact closed production topology', () => {
  for (const key of Object.keys(config())) { const value = config(); delete value[key]; rejected(value); }
  for (const patch of [
    { SUPABASE_PROJECT_REF: 'another' }, { BILLING_ENABLED: 'true' }, { TRANSACTIONAL_EMAIL_FROM: 'Other <noreply@mail.77dominion.com>' },
    { EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED: 'yes' }, { EARLY_ACCESS_AUTH_RECOVERY_TTL_SECONDS: '60' },
    { RESEND_API_KEY: 'invalid' }, { LINEAR_FEEDBACK_API_KEY: 'short' }, { LINEAR_FEEDBACK_API_KEY: 'private\n' + 'a'.repeat(50) },
    { EARLY_ACCESS_INVITATION_KEY: 'a'.repeat(43) }, { EARLY_ACCESS_INVITATION_KEY_VERSION: '0' }, { EARLY_ACCESS_INVITATION_KEY_VERSION: '2147483648' },
    { FEEDBACK_WORKER_SECRET: 'short' }, { EARLY_ACCESS_INVITATION_WORKER_SECRET: 'i'.repeat(42) + '\n' },
  ]) rejected({ ...config(), ...patch });
});
test('new workers and AES key cannot reuse one another or existing authority', () => {
  for (const name of ['FEEDBACK_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_KEY']) {
    for (const other of ['FEEDBACK_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_KEY', 'PROFILE_PHOTO_WORKER_SECRET', 'INTEGRATION_WORKER_SECRET', 'RETIRED_COMMUNITY_WORKER_SECRET', 'SUPABASE_ACCESS_TOKEN']) {
      if (name === other) continue;
      const value = config(); value[other] = value[name]; rejected(value);
    }
  }
});

const fieldLabels = Object.freeze({
  SUPABASE_PROJECT_REF: 'SUPABASE_PROJECT_REF_EXACT', BILLING_ENABLED: 'BILLING_ENABLED_EXACT',
  TRANSACTIONAL_EMAIL_FROM: 'TRANSACTIONAL_EMAIL_FROM_EXACT',
  EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED: 'EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED_EXACT',
  EARLY_ACCESS_AUTH_RECOVERY_TTL_SECONDS: 'EARLY_ACCESS_AUTH_RECOVERY_TTL_SECONDS_EXACT',
  RESEND_API_KEY: 'RESEND_API_KEY_FORMAT', LINEAR_FEEDBACK_API_KEY: 'LINEAR_FEEDBACK_API_KEY_FORMAT',
  EARLY_ACCESS_INVITATION_KEY: 'EARLY_ACCESS_INVITATION_KEY_FORMAT',
  EARLY_ACCESS_INVITATION_KEY_VERSION: 'EARLY_ACCESS_INVITATION_KEY_VERSION_FORMAT',
  FEEDBACK_WORKER_SECRET: 'FEEDBACK_WORKER_SECRET_FORMAT', EARLY_ACCESS_INVITATION_WORKER_SECRET: 'EARLY_ACCESS_INVITATION_WORKER_SECRET_FORMAT',
});
test('diagnostics return only an immutable fixed allowlist and keep successful receipt unchanged', () => {
  assert.deepEqual(diagnoseEarlyAccessRuntimeConfig(config()), []);
  assert.equal(Object.isFrozen(diagnoseEarlyAccessRuntimeConfig(config())), true);
  assert.equal(Object.isFrozen(EARLY_ACCESS_RUNTIME_DIAGNOSTIC_LABELS), true);
  assert.equal(new Set(EARLY_ACCESS_RUNTIME_DIAGNOSTIC_LABELS).size, EARLY_ACCESS_RUNTIME_DIAGNOSTIC_LABELS.length);
  for (const label of EARLY_ACCESS_RUNTIME_DIAGNOSTIC_LABELS) assert.match(label, /^[A-Z_]+$/);
  assert.equal(verifyEarlyAccessRuntimeConfig(config()), true);
});
test('each missing required setting has exactly its fixed label', () => {
  for (const [key, label] of Object.entries(fieldLabels)) {
    const value = config(); delete value[key];
    assert.deepEqual(diagnoseEarlyAccessRuntimeConfig(value), [label]); rejected(value);
    assert.deepEqual(diagnoseEarlyAccessRuntimeConfig({ ...config(), [key]: '' }), [label]);
  }
});
test('each exact public topology predicate retains its exact-value rejection', () => {
  for (const key of Object.keys(fieldLabels).slice(0, 5)) {
    for (const invalid of ['other', config()[key] + ' ', ' ' + config()[key]]) {
      const value = { ...config(), [key]: invalid };
      assert.deepEqual(diagnoseEarlyAccessRuntimeConfig(value), [fieldLabels[key]]); rejected(value);
    }
  }
});
test('secret syntax, bounds, and key-version predicates have fixed labels without normalization', () => {
  const cases = {
    RESEND_API_KEY: ['re_', 're_' + 'r'.repeat(251), 're_private!', ' re_private', 're_private '],
    LINEAR_FEEDBACK_API_KEY: ['l'.repeat(31), 'l'.repeat(513), 'l'.repeat(40) + '\n', 'l'.repeat(40) + ' ', 'l'.repeat(40) + '\x7f', 'l'.repeat(40) + 'é'],
    EARLY_ACCESS_INVITATION_KEY: ['k'.repeat(42), 'k'.repeat(44), 'k'.repeat(42) + '!', config().EARLY_ACCESS_INVITATION_KEY + '='],
    EARLY_ACCESS_INVITATION_KEY_VERSION: ['0', '-1', '01', '1.0', '1e1', '10000000000', ' 1', '1 '],
    FEEDBACK_WORKER_SECRET: ['f'.repeat(42), 'f'.repeat(129), 'f'.repeat(43) + '!', ' ' + 'f'.repeat(43)],
    EARLY_ACCESS_INVITATION_WORKER_SECRET: ['i'.repeat(42), 'i'.repeat(129), 'i'.repeat(43) + '!', 'i'.repeat(43) + ' '],
  };
  for (const [key, values] of Object.entries(cases)) for (const invalid of values) {
    const value = { ...config(), [key]: invalid };
    assert.deepEqual(diagnoseEarlyAccessRuntimeConfig(value), [fieldLabels[key]]); rejected(value);
  }
  for (const invalid of ['2147483648', '9999999999']) {
    const value = { ...config(), EARLY_ACCESS_INVITATION_KEY_VERSION: invalid };
    assert.deepEqual(diagnoseEarlyAccessRuntimeConfig(value), ['EARLY_ACCESS_INVITATION_KEY_VERSION_RANGE']); rejected(value);
  }
});
test('canonical AES-key rejection is distinct from the format predicate', () => {
  const value = { ...config(), EARLY_ACCESS_INVITATION_KEY: 'a'.repeat(43) };
  assert.equal(Buffer.from(value.EARLY_ACCESS_INVITATION_KEY, 'base64url').length, 32);
  assert.deepEqual(diagnoseEarlyAccessRuntimeConfig(value), ['EARLY_ACCESS_INVITATION_KEY_CANONICAL']); rejected(value);
  for (const byte of [0, 1, 3, 127, 255]) {
    const valid = { ...config(), EARLY_ACCESS_INVITATION_KEY: Buffer.alloc(32, byte).toString('base64url') };
    assert.deepEqual(diagnoseEarlyAccessRuntimeConfig(valid), []); assert.equal(verifyEarlyAccessRuntimeConfig(valid), true);
  }
});
test('accepted string boundaries retain every existing format and numeric limit', () => {
  for (const [key, values] of Object.entries({
    RESEND_API_KEY: ['re_r', 're_' + 'r'.repeat(250)], LINEAR_FEEDBACK_API_KEY: ['l'.repeat(32), 'l'.repeat(512)],
    FEEDBACK_WORKER_SECRET: ['f'.repeat(43), 'f'.repeat(128)], EARLY_ACCESS_INVITATION_WORKER_SECRET: ['i'.repeat(43), 'i'.repeat(128)],
    EARLY_ACCESS_INVITATION_KEY_VERSION: ['1', '2147483647'],
  })) for (const valid of values) assert.deepEqual(diagnoseEarlyAccessRuntimeConfig({ ...config(), [key]: valid }), []);
});
test('all existing protected authorities retain collision checks without exposing collision values', () => {
  const newNames = ['FEEDBACK_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_KEY'];
  const protectedNames = [...newNames, 'RESEND_API_KEY', 'LINEAR_FEEDBACK_API_KEY', 'SUPABASE_ACCESS_TOKEN',
    'PROFILE_PHOTO_WORKER_SECRET', 'INTEGRATION_WORKER_SECRET', 'RETIRED_COMMUNITY_WORKER_SECRET',
    'RETIRED_COMMUNITY_DR_HMAC_SECRET', 'INTEGRATION_OAUTH_STATE_SECRET'];
  for (const name of newNames) for (const other of protectedNames) {
    if (name === other) continue;
    const value = config(); value[other] = value[name];
    const labels = diagnoseEarlyAccessRuntimeConfig(value);
    assert.ok(labels.includes(name + '_DISTINCT'));
    if (newNames.includes(other)) assert.ok(labels.includes(other + '_DISTINCT'));
    assert.equal(labels.every(label => EARLY_ACCESS_RUNTIME_DIAGNOSTIC_LABELS.includes(label)), true);
    assert.equal(JSON.stringify(labels).includes(value[name]), false); rejected(value);
  }
});
test('invalid types cannot coerce values or leak a secret through thrown errors', () => {
  let coerced = 0;
  const secret = 'DO_NOT_PRINT_COERCION_SENTINEL';
  const hostile = { [Symbol.toPrimitive]() { coerced++; throw new Error(secret); }, toString() { coerced++; throw new Error(secret); } };
  const invalidValues = [null, false, true, 1, 2147483647, NaN, 1n, Symbol(secret), [], {}, hostile];
  for (const key of Object.keys(fieldLabels)) for (const invalid of invalidValues) {
    const value = { ...config(), [key]: invalid };
    assert.deepEqual(diagnoseEarlyAccessRuntimeConfig(value), [fieldLabels[key]]);
    assert.throws(() => verifyEarlyAccessRuntimeConfig(value), error => {
      assert.equal(Object.hasOwn(error, 'cause'), false);
      assert.equal(error.message.includes(secret), false);
      return error.message === 'Early Access production runtime configuration is incomplete or unsafe.';
    });
  }
  assert.equal(coerced, 0);
});
test('invalid environment, getters, and descriptor failures produce only the fixed input label', () => {
  let invoked = 0;
  const value = config(); Object.defineProperty(value, 'RESEND_API_KEY', { get() { invoked++; throw new Error('DO_NOT_PRINT_GETTER_SENTINEL'); } });
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('DO_NOT_PRINT_PROXY_SENTINEL'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const invalid of [null, false, true, 1, 1n, Symbol('private'), 'private', [], () => {}, value, proxy, revoked.proxy]) {
    assert.deepEqual(diagnoseEarlyAccessRuntimeConfig(invalid), ['ENVIRONMENT_INPUT']); rejected(invalid);
  }
  assert.equal(invoked, 0);
});
test('labels are bounded, deduplicated, stable, and never contain arbitrary setting names or values', () => {
  const sentinel = 'DO_NOT_PRINT_VALUE_SENTINEL';
  const value = Object.fromEntries(Object.keys(config()).map(key => [key, sentinel]));
  value.DO_NOT_PRINT_UNKNOWN_SETTING = sentinel;
  const labels = diagnoseEarlyAccessRuntimeConfig(value);
  assert.deepEqual(labels, EARLY_ACCESS_RUNTIME_DIAGNOSTIC_LABELS.filter(label => labels.includes(label)));
  assert.equal(new Set(labels).size, labels.length);
  assert.equal(labels.length <= EARLY_ACCESS_RUNTIME_DIAGNOSTIC_LABELS.length, true);
  assert.equal(JSON.stringify(labels).includes(sentinel), false);
  assert.equal(JSON.stringify(labels).includes('DO_NOT_PRINT_UNKNOWN_SETTING'), false);
});
const cli = env => spawnSync(process.execPath, [fileURLToPath(new URL('./verify-early-access-runtime-config.mjs', import.meta.url))], {
  env, encoding: 'utf8', timeout: 5000,
});
test('CLI success emits only the existing safe receipt', () => {
  const result = cli(config()); assert.equal(result.status, 0);
  assert.equal(result.stdout, 'Early Access production runtime configuration verified.\n'); assert.equal(result.stderr, '');
});
test('CLI failure emits only the generic message and fixed failed labels, never secret sentinels', () => {
  const sentinel = 'DO_NOT_PRINT_CLI_SENTINEL';
  const value = { ...config(), RESEND_API_KEY: sentinel, EARLY_ACCESS_INVITATION_KEY: sentinel,
    LINEAR_FEEDBACK_API_KEY: sentinel, FEEDBACK_WORKER_SECRET: sentinel, EARLY_ACCESS_INVITATION_WORKER_SECRET: sentinel };
  const result = cli(value); assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Early Access production runtime configuration is incomplete or unsafe.\n'
    + `Failed checks: ${diagnoseEarlyAccessRuntimeConfig(value).join(', ')}\n`);
  assert.equal(result.stderr.includes(sentinel), false);
  assert.doesNotMatch(result.stderr, /\bat file:|cause|length|sha256|https?:\/\//);
});

const diagnosticWorkflow = () => readFileSync(new URL('../.github/workflows/diagnose-production-early-access.yml', import.meta.url), 'utf8');
const jobBlock = (source, name) => source.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [a-z][a-z-]*:\\n|$(?![\\s\\S]))`, 'm'))?.[0];
test('diagnostic workflow is manual-only, read-only, and serialized with normal production releases', () => {
  const workflow = diagnosticWorkflow();
  assert.deepEqual([...workflow.matchAll(/^([a-z][a-z-]*):/gm)].map(match => match[1]), ['name', 'on', 'permissions', 'concurrency', 'jobs']);
  assert.match(workflow, /^on:\n  workflow_dispatch:\n\npermissions:\n  contents: read\n\nconcurrency:\n  group: production-release\n  cancel-in-progress: false\n\njobs:/m);
  assert.deepEqual([...workflow.slice(workflow.indexOf('\njobs:\n')).matchAll(/^  ([a-z][a-z-]*):/gm)].map(match => match[1]), ['authorize', 'diagnose']);
  assert.doesNotMatch(workflow, /\b(inputs|pull_request|pull_request_target|schedule|push|workflow_call|continue-on-error):/);
  assert.equal((workflow.match(/\bpermissions:/g) || []).length, 1);
  assert.equal((workflow.match(/\benvironment:/g) || []).length, 1);
});
test('protected main is authorized before the production environment can expose any credential', () => {
  const workflow = diagnosticWorkflow(); const authorize = jobBlock(workflow, 'authorize');
  assert.equal(authorize, [
    '  authorize:', '    name: Authorize protected-main diagnostics', '    runs-on: ubuntu-latest',
    '    timeout-minutes: 2', '    steps:', '      - name: Require protected main', '        shell: bash', '        run: |',
    '          if [[ "${GITHUB_REF}" != "refs/heads/main" ]]; then',
    '            echo "::error::Production diagnostics must be dispatched from the protected main branch."',
    '            exit 1', '          fi', '', '',
  ].join('\n'));
  const diagnose = jobBlock(workflow, 'diagnose');
  assert.match(diagnose, /^  diagnose:\n    name: Report fixed runtime validation labels\n    needs: authorize\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    environment: production\n    steps:/);
  assert.doesNotMatch(authorize, /\b(env|environment|uses):|secrets\./);
});
test('diagnostic job has exactly pinned checkout and Node setup followed by the sole validator command', () => {
  const workflow = diagnosticWorkflow(); const diagnose = jobBlock(workflow, 'diagnose');
  assert.deepEqual([...diagnose.matchAll(/^      - name: (.*)$/gm)].map(match => match[1]), [
    'Checkout the exact reviewed commit', 'Setup Node', 'Diagnose runtime settings without revealing values',
  ]);
  const beforeValidator = diagnose.split('      - name: Diagnose runtime settings without revealing values\n')[0];
  assert.match(beforeValidator, /      - name: Checkout the exact reviewed commit\n        uses: actions\/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\n        with:\n          ref: \$\{\{ github.sha \}\}\n          persist-credentials: false\n      - name: Setup Node\n        uses: actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4\n        with:\n          node-version: 22\n$/);
  assert.doesNotMatch(beforeValidator, /\benv:|secrets\.|cache:|run:/);
  assert.deepEqual([...diagnose.matchAll(/^        run: (.*)$/gm)].map(match => match[1]), ['node scripts/verify-early-access-runtime-config.mjs']);
  assert.equal((workflow.match(/^        uses:/gm) || []).length, 2);
  assert.equal((workflow.match(/^        env:/gm) || []).length, 1);
  assert.match(diagnose, /        run: node scripts\/verify-early-access-runtime-config\.mjs\n$/);
  assert.doesNotMatch(workflow, /\b(curl|wget|gh|supabase|pnpm|npm|npx|wrangler)\s|upload-artifact|download-artifact|send-approved|configure-production|functions deploy|secrets set|db push|db reset|smtp/i);
});
test('only the final diagnostic step receives exactly the backend validator settings and collision authorities', () => {
  const workflow = diagnosticWorkflow(); const diagnose = jobBlock(workflow, 'diagnose');
  const envBlock = diagnose.match(/^        env:\n([\s\S]*?)^        run:/m)?.[1];
  assert.ok(envBlock);
  const entries = [...envBlock.matchAll(/^          ([A-Z_]+): (.*)$/gm)].map(match => [match[1], match[2]]);
  assert.equal(entries.length, envBlock.trimEnd().split('\n').length);
  const actual = Object.fromEntries(entries);
  const comparedNames = [...Object.keys(config()), 'SUPABASE_ACCESS_TOKEN', 'PROFILE_PHOTO_WORKER_SECRET',
    'INTEGRATION_WORKER_SECRET', 'RETIRED_COMMUNITY_WORKER_SECRET', 'RETIRED_COMMUNITY_DR_HMAC_SECRET', 'INTEGRATION_OAUTH_STATE_SECRET'];
  assert.deepEqual(Object.keys(actual).sort(), comparedNames.sort());
  assert.equal(new Set(entries.map(([key]) => key)).size, entries.length);
  const release = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const backend = jobBlock(release, 'backend');
  const backendJobEnv = backend.match(/^    env:\n([\s\S]*?)^    steps:/m)?.[1];
  const backendGuardEnv = backend.match(/      - name: Validate Early Access runtime and distinct credentials\n        env:\n([\s\S]*?)        run: node scripts\/verify-early-access-runtime-config\.mjs/)[1];
  const backendEnv = Object.fromEntries([
    ...[...backendJobEnv.matchAll(/^      ([A-Z_]+): (.*)$/gm)].map(match => [match[1], match[2]]),
    ...[...backendGuardEnv.matchAll(/^          ([A-Z_]+): (.*)$/gm)].map(match => [match[1], match[2]]),
  ]);
  for (const name of comparedNames) assert.equal(actual[name], backendEnv[name], `Runtime mapping differs: ${name}`);
  assert.equal((workflow.match(/\bsecrets\./g) || []).length, entries.filter(([, value]) => value.startsWith('${{ secrets.')).length);
});
