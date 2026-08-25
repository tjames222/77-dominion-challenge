import AxeBuilder from '@axe-core/playwright';

const BLOCKING_IMPACTS = new Set(['critical', 'serious']);

function nodeSummary(node) {
  return [
    'target=' + JSON.stringify(node.target),
    node.failureSummary || '',
    node.html || '',
  ].filter(Boolean).join('\n');
}

export function blockingAxeViolations(results, allowedRuleIds = []) {
  const allowed = new Set(allowedRuleIds);
  return (results?.violations || []).filter((violation) => (
    BLOCKING_IMPACTS.has(violation.impact) && !allowed.has(violation.id)
  ));
}

export function formatAxeViolations(violations) {
  return violations.map((violation) => [
    violation.id + ' [' + violation.impact + ']: ' + violation.help,
    violation.helpUrl,
    ...violation.nodes.map(nodeSummary),
  ].join('\n')).join('\n\n');
}

export function assertNoBlockingAxeViolations(results, allowedRuleIds = []) {
  const violations = blockingAxeViolations(results, allowedRuleIds);
  if (violations.length) {
    throw new Error('Blocking accessibility violations:\n\n' + formatAxeViolations(violations));
  }
}

export async function analyzeAccessibility(page, options = {}) {
  let builder = new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa',
  ]);

  for (const selector of options.exclude || []) builder = builder.exclude(selector);
  for (const rule of options.disableRules || []) builder = builder.disableRules(rule);
  return builder.analyze();
}

export function assertVisualBuffersEqual(expected, actual) {
  if (!Buffer.isBuffer(expected) || !Buffer.isBuffer(actual)) {
    throw new TypeError('Visual comparisons require screenshot buffers.');
  }
  if (!expected.equals(actual)) {
    throw new Error('Visual output changed. Review the Playwright screenshot and diff artifacts.');
  }
}
