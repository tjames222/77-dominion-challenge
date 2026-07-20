import { initReveal } from './reveal';
import {
  getBillingState,
  getCrews,
  getLocalOrSessionUser,
  getOutboundIntegrationDestinations,
  getOutboundUpdateConsent,
  getProfile,
  hasSupabaseAuth,
  isLocalDemoMode,
  redirectToLogin,
  updateProfile,
  updateOutboundUpdateConsent,
  uploadProfilePhoto,
} from './api';
import {
  PREVIEW_CHALLENGE_RESET_KEYS,
  PREVIEW_CHALLENGE_STORAGE_KEY,
  isPreviewChallengeComplete,
  normalizePreviewChallengeState,
  previewChallengeDay,
  setPreviewChallengeEnabled,
} from './preview-challenge.mjs';
import { hydrateThemeEntitlementState } from './theme-entitlement-state';
import { buildThemeOptionModels } from './theme-entitlements.mjs';
import {
  getActiveTheme,
  getThemeRegistry,
  setTheme,
} from './theme-state';

const load = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
};
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const localDateKey = () => {
  const parts = new Intl.DateTimeFormat('en', { year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const localPreviewMode = isLocalDemoMode();
const themeOptions = [...document.querySelectorAll('[data-theme-mode]')];
const themeSelectionStatus = document.getElementById('themeSelectionStatus');
const dominionNightStatus = document.getElementById('dominionNightStatus');
const dominionNightProgress = document.getElementById('dominionNightProgress');
const dominionNightProgressLabel = document.getElementById('dominionNightProgressLabel');
let themeModelsById = new Map(
  buildThemeOptionModels(null, getThemeRegistry()).map((model) => [model.themeId, model]),
);

function setThemeSelectionStatus(message, tone = '') {
  if (!themeSelectionStatus) return;
  themeSelectionStatus.textContent = message;
  themeSelectionStatus.classList.toggle('error', tone === 'error');
}

function syncThemeOptions() {
  const activeTheme = getActiveTheme();
  themeOptions.forEach((option) => {
    const isActive = option.dataset.themeMode === activeTheme;
    option.classList.toggle('active', isActive);
    option.closest('.appearance-reward-choice')?.classList.toggle('is-active', isActive);
    option.setAttribute('aria-pressed', String(isActive));
  });
}

function renderThemeOptions(catalog, { error = false } = {}) {
  const registry = getThemeRegistry();
  const models = buildThemeOptionModels(catalog, registry);
  themeModelsById = new Map(models.map((model) => [model.themeId, model]));

  themeOptions.forEach((option) => {
    const model = themeModelsById.get(option.dataset.themeMode || '');
    option.setAttribute('aria-disabled', String(!model?.available));
    option.classList.toggle('is-locked', Boolean(model?.locked));
    option.classList.toggle('is-owned', model?.status === 'owned');
    option.closest('.appearance-reward-choice')?.classList.toggle('is-owned', model?.status === 'owned');
    option.classList.remove('is-loading');
  });

  const night = themeModelsById.get('dominion-night');
  if (dominionNightStatus && night) {
    const lowestTier = night.isLowestPointUnlock ? 'lowest point unlock · ' : '';
    dominionNightStatus.textContent = night.available
      ? 'Unlocked reward'
      : !night.featureEnabled
        ? 'Unavailable in this release'
        : error
          ? 'Ownership could not be verified'
          : `Locked · ${lowestTier}${night.currentPoints} of ${night.pointsRequired} points`;
  }
  if (dominionNightProgress && night) {
    const progress = Math.round(night.progressPercent);
    dominionNightProgress.setAttribute('aria-valuenow', String(progress));
    dominionNightProgress.style.setProperty('--theme-progress', `${progress}%`);
  }
  if (dominionNightProgressLabel && night) {
    dominionNightProgressLabel.textContent = night.available
      ? 'Dominion Night is unlocked.'
      : !night.featureEnabled
        ? 'Dominion Night is unavailable in this release.'
        : night.locked && !error
          ? `${Math.round(night.progressPercent)}% complete. ${night.pointsRemaining} points to unlock.`
          : night.reason || 'Theme ownership could not be verified.';
  }

  if (error) {
    setThemeSelectionStatus('Theme reward ownership could not be verified. Dark and Light remain available.', 'error');
  } else if (night?.available) {
    setThemeSelectionStatus('Dominion Night is unlocked and ready to use.');
  } else if (!night?.featureEnabled) {
    setThemeSelectionStatus('Dominion Night is unavailable in this release.');
  } else if (night?.locked) {
    setThemeSelectionStatus(`${night.isLowestPointUnlock ? 'Lowest point reward: ' : ''}Earn ${night.pointsRemaining} more points to unlock Dominion Night.`);
  } else {
    setThemeSelectionStatus(night?.reason || 'Theme rewards are unavailable in this release.');
  }
  syncThemeOptions();
}

async function hydrateThemeOptions() {
  const result = await hydrateThemeEntitlementState();
  if (result.error) console.warn('Unable to verify theme reward ownership', result.error);
  renderThemeOptions(result.catalog, { error: Boolean(result.error) || !result.authenticated });
}

themeOptions.forEach((option) => {
  option.addEventListener('click', () => {
    const themeId = option.dataset.themeMode || 'dark';
    const model = themeModelsById.get(themeId);
    if (!model?.available) {
      setThemeSelectionStatus(model?.reason || 'This theme is locked.', 'error');
      return;
    }
    const selectedTheme = setTheme(themeId);
    setThemeSelectionStatus(selectedTheme === themeId
      ? `${model.label} theme selected.`
      : 'That theme is not available right now.', selectedTheme === themeId ? '' : 'error');
  });
});
window.addEventListener(window.DominionThemeRuntime.changeEvent, syncThemeOptions);
syncThemeOptions();

const profileNameEl = document.getElementById('profileName');
const profileEmailEl = document.getElementById('profileEmail');
const profileAvatarImageEl = document.getElementById('profileAvatarImage');
const profileAvatarFallbackEl = document.getElementById('profileAvatarFallback');
const profileForm = document.getElementById('profileForm');
const profilePhotoField = document.getElementById('profilePhotoField');
const profilePhotoInput = document.getElementById('profilePhotoInput');
const profilePhotoFilename = document.getElementById('profilePhotoFilename');
const profileNameInput = document.getElementById('profileNameInput');
const profileEmailInput = document.getElementById('profileEmailInput');
const profileFeedback = document.getElementById('profileFeedback');
const profilePreviewTools = document.getElementById('profilePreviewTools');
const profilePreviewChallengeSwitch = document.getElementById('profilePreviewChallengeSwitch');
const profilePreviewStatus = document.getElementById('profilePreviewStatus');
const resetPreviewChallengeButton = document.getElementById('resetPreviewChallengeButton');
const integrationConsentCrew = document.getElementById('integrationConsentCrew');
const integrationConsentNoGroups = document.getElementById('integrationConsentNoGroups');
const integrationConsentContent = document.getElementById('integrationConsentContent');
const integrationDestinationList = document.getElementById('integrationDestinationList');
const integrationDestinationEmpty = document.getElementById('integrationDestinationEmpty');
const integrationConsentForm = document.getElementById('integrationConsentForm');
const integrationUpdatesEnabled = document.getElementById('integrationUpdatesEnabled');
const integrationShareCheckIns = document.getElementById('integrationShareCheckIns');
const integrationShareStreaks = document.getElementById('integrationShareStreaks');
const integrationShareBadges = document.getElementById('integrationShareBadges');
const integrationShareMembership = document.getElementById('integrationShareMembership');
const integrationConsentFeedback = document.getElementById('integrationConsentFeedback');
const saveIntegrationConsent = document.getElementById('saveIntegrationConsent');
const MAX_PROFILE_PHOTO_SIZE = 5 * 1024 * 1024;
let currentProfile = { name: 'Member', email: 'Logged in', avatarUrl: '' };
let selectedPhotoFile = null;
let selectedPreviewUrl = '';
let integrationCrews = [];
const EMPTY_PHOTO_FILENAME = 'No new photo selected';
let previewChallengeState = normalizePreviewChallengeState(
  localPreviewMode ? load(PREVIEW_CHALLENGE_STORAGE_KEY, {}) : {},
  localDateKey(),
);

function renderPreviewChallengeTools() {
  if (!profilePreviewTools) return;
  profilePreviewTools.hidden = !localPreviewMode;
  if (!localPreviewMode) return;

  const day = previewChallengeDay(previewChallengeState);
  const complete = isPreviewChallengeComplete(previewChallengeState);
  if (profilePreviewChallengeSwitch) profilePreviewChallengeSwitch.checked = previewChallengeState.enabled;
  if (profilePreviewStatus) {
    profilePreviewStatus.textContent = complete
      ? 'Preview run complete: all 77 challenge days are posted. Reset to test another full run.'
      : previewChallengeState.enabled
        ? `Next preview check-in: Day ${day} of 77.`
        : day > 1
          ? `77-day test mode is paused before Day ${day} of 77.`
          : 'Turn on the switch to begin with Day 1 of 77.';
  }
}

function initialsFor(name, email) {
  const source = String(name || email || 'Member').trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return (source[0] || 'M').toUpperCase();
}

function revokeSelectedPreview() {
  if (!selectedPreviewUrl) return;
  URL.revokeObjectURL(selectedPreviewUrl);
  selectedPreviewUrl = '';
}

function renderPhotoSelection(file = null) {
  if (profilePhotoFilename) {
    const filename = String(file?.name || '').trim();
    profilePhotoFilename.textContent = filename || EMPTY_PHOTO_FILENAME;
    profilePhotoFilename.title = filename;
  }
  profilePhotoField?.classList.toggle('has-selection', Boolean(file));
}

function renderAvatar(profile) {
  const avatarUrl = profile?.avatarUrl || '';
  if (profileAvatarFallbackEl) {
    profileAvatarFallbackEl.textContent = initialsFor(profile?.name, profile?.email);
    profileAvatarFallbackEl.hidden = Boolean(avatarUrl);
  }
  if (!profileAvatarImageEl) return;
  if (avatarUrl) {
    profileAvatarImageEl.src = avatarUrl;
    profileAvatarImageEl.hidden = false;
  } else {
    profileAvatarImageEl.removeAttribute('src');
    profileAvatarImageEl.hidden = true;
  }
}

function renderProfile(profile) {
  currentProfile = {
    ...currentProfile,
    ...profile,
    avatarUrl: profile?.avatarUrl || '',
  };
  if (profileNameEl) profileNameEl.textContent = currentProfile.name || 'Member';
  if (profileEmailEl) profileEmailEl.textContent = currentProfile.email || 'Logged in';
  if (profileNameInput) profileNameInput.value = currentProfile.name || '';
  if (profileEmailInput) profileEmailInput.value = currentProfile.email || '';
  renderAvatar(currentProfile);
}

function syncStoredUser(profile) {
  const storedUser = {
    name: profile.name || 'Member',
    email: profile.email || '',
    avatarUrl: profile.avatarUrl || '',
    authenticated: true,
  };
  save('dominion:user', storedUser);
  if (storedUser.name) save('dominion:memberName', storedUser.name);
}

function setProfileFeedback(message, tone = '') {
  if (!profileFeedback) return;
  profileFeedback.textContent = message;
  profileFeedback.classList.toggle('error', tone === 'error');
}

function setProfileFormBusy(isBusy, label = 'Save profile') {
  const submitButton = profileForm?.querySelector('button[type="submit"]');
  if (profilePhotoInput) profilePhotoInput.disabled = isBusy;
  if (profilePhotoField) profilePhotoField.setAttribute('aria-busy', String(isBusy));
  if (submitButton) {
    submitButton.disabled = isBusy;
    submitButton.textContent = isBusy ? 'Saving...' : label;
  }
}

function updateBillingSummary(state) {
  document.getElementById('profileChallengeStatus').textContent = state.appAccess ? 'Status: Active' : 'Status: Subscription required';
  document.getElementById('profileBillingTitle').textContent = state.subscriptionActive
    ? 'Subscription active'
    : 'Subscription needed';
  document.getElementById('profileBillingCopy').textContent = state.subscriptionActive
    ? 'Your $7/month subscription is active, so the dashboard, daily actions, community, journal, and future member content stay open.'
    : 'Subscribe for $7/month to unlock the dashboard, daily action page, community, journal, and full tracking flow.';
  document.getElementById('profileSubscriptionPill').textContent = state.subscriptionActive ? 'Subscription active' : 'Subscription needed';
}

function setIntegrationConsentFeedback(message, tone = '') {
  if (!integrationConsentFeedback) return;
  integrationConsentFeedback.textContent = message;
  integrationConsentFeedback.classList.toggle('error', tone === 'error');
}

function setIntegrationConsentBusy(isBusy, busyLabel = 'Saving...') {
  if (integrationConsentContent) {
    integrationConsentContent.setAttribute('aria-busy', String(isBusy));
  }
  if (integrationConsentCrew) integrationConsentCrew.disabled = isBusy || integrationCrews.length === 0;
  integrationConsentForm?.querySelectorAll('input, button').forEach((control) => {
    control.disabled = isBusy;
  });
  if (saveIntegrationConsent) saveIntegrationConsent.textContent = isBusy ? busyLabel : 'Save update privacy';
}

function renderIntegrationDestinations(destinations = []) {
  if (!integrationDestinationList || !integrationDestinationEmpty) return;
  integrationDestinationList.replaceChildren();
  integrationDestinationEmpty.hidden = destinations.length > 0;

  destinations.forEach((destination) => {
    const item = document.createElement('li');
    item.className = 'integration-destination-item';
    const identity = document.createElement('span');
    const name = document.createElement('strong');
    const context = document.createElement('small');
    const status = document.createElement('em');
    const platformName = destination.platform === 'slack' ? 'Slack' : 'Discord';

    name.textContent = `${platformName} · ${destination.name}`;
    context.textContent = destination.context || `${platformName} destination`;
    status.textContent = 'Connected';
    identity.append(name, context);
    item.append(identity, status);
    integrationDestinationList.append(item);
  });
}

function renderIntegrationConsent(consent) {
  if (integrationUpdatesEnabled) integrationUpdatesEnabled.checked = consent.outboundUpdatesEnabled;
  integrationConsentForm?.querySelectorAll('[name="integrationPresentation"]').forEach((option) => {
    option.checked = option.value === consent.presentationMode;
  });
  if (integrationShareCheckIns) integrationShareCheckIns.checked = consent.events.checkIns;
  if (integrationShareStreaks) integrationShareStreaks.checked = consent.events.streakMilestones;
  if (integrationShareBadges) integrationShareBadges.checked = consent.events.badgesRewards;
  if (integrationShareMembership) integrationShareMembership.checked = consent.events.membership;

  if (!consent.consentRecorded) {
    setIntegrationConsentFeedback('Nothing is shared until you choose categories, turn on updates, and save.');
  } else if (!consent.outboundUpdatesEnabled) {
    setIntegrationConsentFeedback('Outbound updates are off for this group. Pending attempts will be blocked.');
  } else {
    setIntegrationConsentFeedback('Your saved choices are checked again before every delivery attempt.');
  }
}

function failClosedIntegrationConsent() {
  return {
    consentRecorded: false,
    outboundUpdatesEnabled: false,
    presentationMode: 'anonymous',
    events: {
      checkIns: false,
      streakMilestones: false,
      badgesRewards: false,
      membership: false,
    },
  };
}

async function loadSelectedIntegrationConsent() {
  const crewId = integrationConsentCrew?.value || '';
  if (!crewId || !integrationConsentContent) return;

  let loaded = false;
  renderIntegrationConsent(failClosedIntegrationConsent());
  renderIntegrationDestinations([]);
  setIntegrationConsentBusy(true, 'Loading...');
  setIntegrationConsentFeedback('Loading update privacy...');
  try {
    const [consent, destinations] = await Promise.all([
      getOutboundUpdateConsent(crewId),
      getOutboundIntegrationDestinations(crewId),
    ]);
    renderIntegrationConsent(consent);
    renderIntegrationDestinations(destinations);
    loaded = true;
  } catch (error) {
    console.warn('Unable to load outbound update consent', error);
    renderIntegrationDestinations([]);
    setIntegrationConsentFeedback(error?.message || 'Unable to load update privacy right now.', 'error');
  } finally {
    setIntegrationConsentBusy(false);
    if (!loaded) {
      integrationConsentForm?.querySelectorAll('input, button').forEach((control) => {
        control.disabled = true;
      });
    }
  }
}

async function hydrateIntegrationConsent() {
  if (!integrationConsentCrew || !integrationConsentContent || !integrationConsentNoGroups) return;
  integrationConsentCrew.disabled = true;
  setIntegrationConsentFeedback('Loading your groups...');

  try {
    integrationCrews = await getCrews();
    integrationConsentCrew.replaceChildren();

    if (!integrationCrews.length) {
      integrationConsentNoGroups.hidden = false;
      integrationConsentContent.hidden = true;
      integrationConsentCrew.append(new Option('No private groups', ''));
      integrationConsentCrew.disabled = true;
      return;
    }

    integrationCrews.forEach((crew) => {
      integrationConsentCrew.append(new Option(crew.name || 'Private group', crew.id));
    });
    integrationConsentNoGroups.hidden = true;
    integrationConsentContent.hidden = false;
    await loadSelectedIntegrationConsent();
  } catch (error) {
    console.warn('Unable to load integration privacy groups', error);
    integrationCrews = [];
    integrationConsentCrew.replaceChildren(new Option('Groups unavailable', ''));
    integrationConsentCrew.disabled = true;
    integrationConsentNoGroups.hidden = false;
    integrationConsentNoGroups.textContent = 'Unable to load your private groups right now.';
    integrationConsentContent.hidden = true;
  }
}

async function hydrateProfile() {
  if (!hasSupabaseAuth() && isLocalDemoMode()) {
    const user = load('dominion:user', { name: 'Member', email: 'Logged in', avatarUrl: '' });
    const billing = await getBillingState();
    if (!billing.authenticated) {
      redirectToLogin('./profile.html');
      return false;
    }
    renderProfile(user);
    updateBillingSummary(billing);
    return true;
  }

  if (!hasSupabaseAuth()) {
    redirectToLogin('./profile.html');
    return false;
  }

  try {
    const billing = await getBillingState();
    if (!billing.authenticated) {
      redirectToLogin('./profile.html');
      return false;
    }

    const sessionUser = await getLocalOrSessionUser();
    const profile = await getProfile();
    const syncedUser = {
      name: profile.name || sessionUser?.name || 'Member',
      email: profile.email || sessionUser?.email || 'Logged in',
      avatarUrl: profile.avatarUrl || sessionUser?.avatarUrl || '',
      authenticated: true,
    };
    syncStoredUser(syncedUser);
    renderProfile(syncedUser);
    updateBillingSummary(billing);
    return true;
  } catch (error) {
    console.warn('Unable to load profile from Supabase', error);
    setProfileFeedback('Unable to load your profile right now.', 'error');
    return false;
  }
}

profilePhotoInput?.addEventListener('change', () => {
  revokeSelectedPreview();
  selectedPhotoFile = null;
  renderPhotoSelection();

  const file = profilePhotoInput.files?.[0];
  if (!file) {
    renderAvatar(currentProfile);
    return;
  }

  if (!file.type?.startsWith('image/')) {
    profilePhotoInput.value = '';
    setProfileFeedback('Profile picture must be an image file.', 'error');
    renderAvatar(currentProfile);
    return;
  }

  if (file.size > MAX_PROFILE_PHOTO_SIZE) {
    profilePhotoInput.value = '';
    setProfileFeedback('Profile picture must be smaller than 5 MB.', 'error');
    renderAvatar(currentProfile);
    return;
  }

  selectedPhotoFile = file;
  selectedPreviewUrl = URL.createObjectURL(file);
  renderPhotoSelection(file);
  renderAvatar({ ...currentProfile, avatarUrl: selectedPreviewUrl });
  setProfileFeedback(`“${file.name}” selected. Save profile when ready.`);
});

profileForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = profileNameInput?.value.trim() || '';
  const email = profileEmailInput?.value.trim() || '';
  const originalButtonLabel = profileForm.querySelector('button[type="submit"]')?.textContent || 'Save profile';

  if (!name || !email) {
    setProfileFeedback('Name and email are required.', 'error');
    return;
  }

  setProfileFormBusy(true);
  setProfileFeedback(selectedPhotoFile ? 'Uploading profile picture...' : 'Saving profile...');

  try {
    let avatarUrl = currentProfile.avatarUrl || '';
    if (selectedPhotoFile) avatarUrl = await uploadProfilePhoto(selectedPhotoFile);

    const savedProfile = await updateProfile({ name, email, avatarUrl });
    const nextProfile = {
      name: savedProfile?.name || name,
      email: savedProfile?.email || email,
      avatarUrl: savedProfile?.avatarUrl || avatarUrl,
    };

    selectedPhotoFile = null;
    if (profilePhotoInput) profilePhotoInput.value = '';
    revokeSelectedPreview();
    renderPhotoSelection();
    syncStoredUser(nextProfile);
    renderProfile(nextProfile);
    setProfileFeedback(savedProfile?.emailChangeRequested
      ? 'Profile saved. Confirm the email change from your inbox.'
      : 'Profile saved.');
  } catch (error) {
    renderAvatar(selectedPreviewUrl
      ? { ...currentProfile, avatarUrl: selectedPreviewUrl }
      : currentProfile);
    setProfileFeedback(error?.message || 'Unable to save your profile right now.', 'error');
  } finally {
    setProfileFormBusy(false, originalButtonLabel);
  }
});

profilePreviewChallengeSwitch?.addEventListener('change', () => {
  if (!localPreviewMode) return;
  previewChallengeState = setPreviewChallengeEnabled(
    previewChallengeState,
    profilePreviewChallengeSwitch.checked,
    localDateKey(),
  );
  save(PREVIEW_CHALLENGE_STORAGE_KEY, previewChallengeState);
  renderPreviewChallengeTools();
});

resetPreviewChallengeButton?.addEventListener('click', () => {
  if (!localPreviewMode) return;
  const confirmed = window.confirm('Reset all preview challenge days, check-ins, points, streaks, badges, and dashboard feed? Your profile, Community content, journal, and workout difficulty will stay intact.');
  if (!confirmed) return;

  const remainsEnabled = previewChallengeState.enabled;
  PREVIEW_CHALLENGE_RESET_KEYS.forEach((key) => localStorage.removeItem(key));
  previewChallengeState = setPreviewChallengeEnabled({}, remainsEnabled, localDateKey());
  save(PREVIEW_CHALLENGE_STORAGE_KEY, previewChallengeState);
  renderPreviewChallengeTools();
});

integrationConsentCrew?.addEventListener('change', () => {
  loadSelectedIntegrationConsent();
});

integrationConsentForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const crewId = integrationConsentCrew?.value || '';
  if (!crewId) return;

  const presentationMode = integrationConsentForm
    .querySelector('[name="integrationPresentation"]:checked')?.value || 'anonymous';
  setIntegrationConsentBusy(true);
  setIntegrationConsentFeedback('Saving your update privacy...');
  try {
    const consent = await updateOutboundUpdateConsent(crewId, {
      outboundUpdatesEnabled: Boolean(integrationUpdatesEnabled?.checked),
      presentationMode,
      events: {
        checkIns: Boolean(integrationShareCheckIns?.checked),
        streakMilestones: Boolean(integrationShareStreaks?.checked),
        badgesRewards: Boolean(integrationShareBadges?.checked),
        membership: Boolean(integrationShareMembership?.checked),
      },
    });
    renderIntegrationConsent(consent);
    setIntegrationConsentFeedback(consent.outboundUpdatesEnabled
      ? 'Update privacy saved. These choices will be checked before every send and retry.'
      : 'Update privacy saved. Outbound updates and pending attempts are blocked.');
  } catch (error) {
    console.warn('Unable to save outbound update consent', error);
    setIntegrationConsentFeedback(error?.message || 'Unable to save update privacy right now.', 'error');
  } finally {
    setIntegrationConsentBusy(false);
  }
});

window.addEventListener('storage', (event) => {
  if (!localPreviewMode || event.key !== PREVIEW_CHALLENGE_STORAGE_KEY) return;
  previewChallengeState = normalizePreviewChallengeState(
    load(PREVIEW_CHALLENGE_STORAGE_KEY, {}),
    localDateKey(),
  );
  renderPreviewChallengeTools();
});

renderPreviewChallengeTools();
async function hydratePage() {
  const authenticated = await hydrateProfile();
  const themeHydration = hydrateThemeOptions();
  if (authenticated) await hydrateIntegrationConsent();
  await themeHydration;
}
hydratePage();
initReveal();
