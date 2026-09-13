export const communityPreviewMessage = (integrationsEnabled = false) => integrationsEnabled
  ? 'Preview mode: groups, leaderboards, and integrations use local mock data.'
  : 'Preview mode: groups and leaderboards use local mock data. External channel connections are disabled.';

// This is build-time presentation, never an authentication or entitlement gate.
// Rendering the known preview notice in HTML avoids moving the whole Community
// page after its initial paint; production keeps the ordinary empty status area.
export function renderInitialPreviewFeedback(html, { mocksEnabled = false, integrationsEnabled = false } = {}) {
  if (!mocksEnabled) return html;
  return html.replace(
    /<div class="community-feedback" id="communityFeedback"([^>]*)><\/div>/,
    `<div class="community-feedback active" id="communityFeedback"$1>${communityPreviewMessage(integrationsEnabled)}</div>`,
  );
}
