// Provider receipts are metadata, not delivery proof or retry authorization.
// Keep the existing 128-byte state budget and preserve accepted IDs verbatim.
export function validProviderMessageId(value) {
  if (typeof value !== 'string' || value.length > 128 ||
    /[^!-~]/.test(value)) return false;
  if (/^[A-Za-z0-9_-]{8,128}$/.test(value)) return true;
  // Bounded ASCII dot-atoms and DNS labels cover native Cloudflare Message-IDs
  // without accepting quoted text, whitespace, header controls or normalization.
  const match = /^<([A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*)@([A-Za-z0-9.-]+)>$/.exec(value);
  if (!match || match[1].length > 64) return false;
  const labels = match[2].split('.');
  return labels.length >= 2 && labels.every(label =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
