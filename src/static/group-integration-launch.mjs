export function groupIntegrationsEnabled(value) {
  return value === true || String(value || '').trim().toLowerCase() === 'true';
}
