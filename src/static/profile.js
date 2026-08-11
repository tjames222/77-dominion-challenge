import { initReveal } from './reveal';
import {
  getBillingState,
  getCrews,
  getLocalOrSessionUser,
  getOutboundIntegrationDestinations,
  getOutboundUpdateConsent,
  getProfile,
  hasSupabaseAuth,
  hasSupabaseAuthentication,
  isLocalDemoMode,
  redirectToLogin,
  replaceProfilePhoto,
  setThemePreference,
  subscribeToAuthStateChanges,
  updateProfile,
  updateOutboundUpdateConsent,
} from './api';
import { prepareProfilePhoto } from './profile-photo.mjs';
import {
  PREVIEW_CHALLENGE_STORAGE_KEY,
  isPreviewChallengeComplete,
  normalizePreviewChallengeState,
  previewChallengeDay,
  setPreviewChallengeEnabled,
} from './preview-challenge.mjs';
import {
  PREVIEW_USER_STATE_STORAGE_KEY,
  readPreviewUserValue,
  writePreviewUserValue,
} from './preview-user-state.mjs';
import { hydrateThemeEntitlementState } from './theme-entitlement-state';
import { buildThemeOptionModels } from './theme-entitlements.mjs';
import {
  getActiveTheme,
  getThemeRegistry,
  setTheme,
} from './theme-state';

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
let themePreferenceSaving = false;

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

async function hydrateThemeOptions(owner = captureProfileOwner()) {
  if (!owner) return;
  const result = await hydrateThemeEntitlementState();
  if (!isCurrentProfileOwner(owner)) return;
  if (result.error) console.warn('Unable to verify theme reward ownership', result.error);
  renderThemeOptions(result.catalog, { error: Boolean(result.error) || !result.authenticated });
}

themeOptions.forEach((option) => {
  option.addEventListener('click', async () => {
    if (themePreferenceSaving) return;
    const themeId = option.dataset.themeMode || 'dark';
    const model = themeModelsById.get(themeId);
    if (!model?.available) {
      setThemeSelectionStatus(model?.reason || 'This theme is locked.', 'error');
      return;
    }
    const previousTheme = getActiveTheme();
    const selectedTheme = setTheme(themeId);
    if (selectedTheme !== themeId) {
      setThemeSelectionStatus('That theme is not available right now.', 'error');
      return;
    }

    themePreferenceSaving = true;
    option.setAttribute('aria-busy', 'true');
    setThemeSelectionStatus(`Saving ${model.label} theme...`);
    try {
      await setThemePreference(themeId);
      setThemeSelectionStatus(`${model.label} theme selected.`);
    } catch (error) {
      setTheme(previousTheme);
      setThemeSelectionStatus(error?.message || 'Unable to save that theme right now.', 'error');
    } finally {
      themePreferenceSaving = false;
      option.removeAttribute('aria-busy');
      syncThemeOptions();
    }
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
const profilePhotoHint = document.getElementById('profilePhotoHint');
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
const hybridAuthPreview = localPreviewMode && hasSupabaseAuthentication();
if (profileEmailInput && hybridAuthPreview) {
  profileEmailInput.readOnly = true;
  profileEmailInput.title = 'Sign-in email changes are disabled on the dev preview.';
}
let currentProfile = { name: 'Member', email: 'Logged in', avatarUrl: '', updatedAt: '' };
let selectedPhotoFile = null;
let selectedPreparedPhoto = null;
let selectedPreviewUrl = '';
let photoPreparationSequence = 0;
let profilePhotoAvailable = localPreviewMode;
let integrationCrews = [];
let currentPreviewOwnerId = '';
let observedProfileOwner = '';
let hydratedProfileOwner = '';
let profileOwnerEpoch = 0;
let profileHydrationRequestId = 0;
const EMPTY_PHOTO_FILENAME = 'No new photo selected';
const PROFILE_PHOTO_HINT = 'JPG, PNG, WebP, HEIC or HEIF · 5 MB input max · cropped to a square thumbnail up to 256×256 and 150 KB';
let previewChallengeState = normalizePreviewChallengeState({}, localDateKey());

function renderPreviewChallengeTools() {
  if (!profilePreviewTools) return;
  profilePreviewTools.hidden = !localPreviewMode;
  if (!localPreviewMode) return;

  const day = previewChallengeDay(previewChallengeState);
  const complete = isPreviewChallengeComplete(previewChallengeState);
  if (profilePreviewChallengeSwitch) profilePreviewChallengeSwitch.checked = previewChallengeState.enabled;
  if (profilePreviewChallengeSwitch) profilePreviewChallengeSwitch.disabled = !currentPreviewOwnerId;
  if (resetPreviewChallengeButton) resetPreviewChallengeButton.disabled = true;
  if (profilePreviewStatus) {
    profilePreviewStatus.textContent = complete
      ? 'Preview run complete: all 77 challenge days are posted. A new full run requires clearing this account’s saved progress and rewards together; reset is currently unavailable.'
      : previewChallengeState.enabled
        ? `Next preview check-in: Day ${day} of 77.`
        : day > 1
          ? `77-day test mode is paused before Day ${day} of 77.`
          : 'Turn on the switch to begin with Day 1 of 77.';
  }
}

function loadCurrentPreviewChallengeState() {
  previewChallengeState = currentPreviewOwnerId
    ? normalizePreviewChallengeState(
        readPreviewUserValue(
          localStorage,
          currentPreviewOwnerId,
          PREVIEW_CHALLENGE_STORAGE_KEY,
          {},
        ),
        localDateKey(),
      )
    : normalizePreviewChallengeState({}, localDateKey());
}

function saveCurrentPreviewValue(key, value) {
  if (!currentPreviewOwnerId) throw new Error('The preview account is still loading.');
  return writePreviewUserValue(localStorage, currentPreviewOwnerId, key, value);
}

const captureProfileOwner = () => hydratedProfileOwner
  && hydratedProfileOwner === observedProfileOwner
  ? { userId: hydratedProfileOwner, epoch: profileOwnerEpoch }
  : null;
const isCurrentProfileOwner = (owner) => Boolean(
  owner
    && owner.epoch === profileOwnerEpoch
    && owner.userId === hydratedProfileOwner
    && owner.userId === observedProfileOwner,
);

function invalidateProfileOwner(nextOwner = '') {
  profileOwnerEpoch += 1;
  profileHydrationRequestId += 1;
  observedProfileOwner = String(nextOwner || '');
  hydratedProfileOwner = '';
  currentPreviewOwnerId = '';
  previewChallengeState = normalizePreviewChallengeState({}, localDateKey());
  selectedPhotoFile = null;
  selectedPreparedPhoto = null;
  if (profilePhotoInput) profilePhotoInput.value = '';
  revokeSelectedPreview();
  renderPhotoSelection();
  currentProfile = {
    name: '',
    email: '',
    avatarUrl: '',
    updatedAt: '',
    profilePhotoAvailable: false,
  };
  if (profileNameEl) profileNameEl.textContent = 'Loading profile…';
  if (profileEmailEl) profileEmailEl.textContent = 'Verifying account…';
  if (profileNameInput) profileNameInput.value = '';
  if (profileEmailInput) profileEmailInput.value = '';
  renderAvatar(currentProfile);
  setProfileFeedback('Loading your profile…');
  const challengeStatus = document.getElementById('profileChallengeStatus');
  const billingTitle = document.getElementById('profileBillingTitle');
  const billingCopy = document.getElementById('profileBillingCopy');
  const subscriptionPill = document.getElementById('profileSubscriptionPill');
  if (challengeStatus) challengeStatus.textContent = 'Status: Checking access';
  if (billingTitle) billingTitle.textContent = 'Billing access';
  if (billingCopy) billingCopy.textContent = 'Loading your subscription details.';
  if (subscriptionPill) subscriptionPill.textContent = 'Checking access';
  integrationCrews = [];
  integrationConsentCrew?.replaceChildren(new Option('Loading groups…', ''));
  if (integrationConsentNoGroups) integrationConsentNoGroups.hidden = true;
  if (integrationConsentContent) integrationConsentContent.hidden = true;
  renderIntegrationConsent(failClosedIntegrationConsent());
  renderIntegrationDestinations([]);
  setIntegrationConsentFeedback('Loading update privacy…');
  renderThemeOptions(null, { error: true });
  renderPreviewChallengeTools();
  profileForm?.querySelectorAll('input, button').forEach((control) => { control.disabled = true; });
  integrationConsentForm?.querySelectorAll('input, button').forEach((control) => { control.disabled = true; });
  if (integrationConsentCrew) integrationConsentCrew.disabled = true;
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

function syncProfilePhotoAvailability(available) {
  profilePhotoAvailable = localPreviewMode || available === true;
  if (profilePhotoInput) profilePhotoInput.disabled = !profilePhotoAvailable;
  profilePhotoField?.setAttribute('aria-disabled', String(!profilePhotoAvailable));
  if (profilePhotoHint) {
    profilePhotoHint.textContent = profilePhotoAvailable
      ? PROFILE_PHOTO_HINT
      : 'Profile pictures are temporarily unavailable while secure thumbnail storage is upgraded.';
  }
}

function renderProfile(profile) {
  currentProfile = {
    ...currentProfile,
    ...profile,
    avatarUrl: profile?.avatarUrl || '',
    profilePhotoAvailable: profile?.profilePhotoAvailable ?? currentProfile.profilePhotoAvailable,
  };
  syncProfilePhotoAvailability(currentProfile.profilePhotoAvailable);
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
  if (profilePhotoInput) profilePhotoInput.disabled = isBusy || !profilePhotoAvailable;
  if (profilePhotoField) profilePhotoField.setAttribute('aria-busy', String(isBusy));
  if (submitButton) {
    submitButton.disabled = isBusy;
    submitButton.textContent = isBusy ? 'Saving...' : label;
  }
}

function enableHydratedProfileForm() {
  profileForm?.querySelectorAll('input, button').forEach((control) => { control.disabled = false; });
  syncProfilePhotoAvailability(profilePhotoAvailable);
}

profileAvatarImageEl?.addEventListener('error', () => {
  profileAvatarImageEl.removeAttribute('src');
  profileAvatarImageEl.hidden = true;
  if (profileAvatarFallbackEl) profileAvatarFallbackEl.hidden = false;
});

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

async function loadSelectedIntegrationConsent(owner = captureProfileOwner()) {
  if (!owner) return;
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
    if (!isCurrentProfileOwner(owner)) return;
    renderIntegrationConsent(consent);
    renderIntegrationDestinations(destinations);
    loaded = true;
  } catch (error) {
    if (!isCurrentProfileOwner(owner)) return;
    console.warn('Unable to load outbound update consent', error);
    renderIntegrationDestinations([]);
    setIntegrationConsentFeedback(error?.message || 'Unable to load update privacy right now.', 'error');
  } finally {
    if (isCurrentProfileOwner(owner)) setIntegrationConsentBusy(false);
    if (isCurrentProfileOwner(owner) && !loaded) {
      integrationConsentForm?.querySelectorAll('input, button').forEach((control) => {
        control.disabled = true;
      });
    }
  }
}

async function hydrateIntegrationConsent(owner = captureProfileOwner()) {
  if (!owner) return;
  if (!integrationConsentCrew || !integrationConsentContent || !integrationConsentNoGroups) return;
  integrationConsentCrew.disabled = true;
  setIntegrationConsentFeedback('Loading your groups...');

  try {
    integrationCrews = await getCrews();
    if (!isCurrentProfileOwner(owner)) return;
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
    await loadSelectedIntegrationConsent(owner);
  } catch (error) {
    if (!isCurrentProfileOwner(owner)) return;
    console.warn('Unable to load integration privacy groups', error);
    integrationCrews = [];
    integrationConsentCrew.replaceChildren(new Option('Groups unavailable', ''));
    integrationConsentCrew.disabled = true;
    integrationConsentNoGroups.hidden = false;
    integrationConsentNoGroups.textContent = 'Unable to load your private groups right now.';
    integrationConsentContent.hidden = true;
  }
}

async function hydrateProfile(expectedOwnerId = observedProfileOwner) {
  const requestId = ++profileHydrationRequestId;
  const requestedOwner = String(expectedOwnerId || '');
  if (!hasSupabaseAuth() && isLocalDemoMode()) {
    const user = await getLocalOrSessionUser();
    const billing = await getBillingState();
    if (!billing.authenticated || !user?.userId) {
      redirectToLogin('./profile.html');
      return false;
    }
    if (requestId !== profileHydrationRequestId
      || (requestedOwner && requestedOwner !== user.userId)
      || (observedProfileOwner && observedProfileOwner !== user.userId)) return false;
    observedProfileOwner ||= user.userId;
    hydratedProfileOwner = user.userId;
    currentPreviewOwnerId = user.userId;
    loadCurrentPreviewChallengeState();
    renderPreviewChallengeTools();
    renderProfile(user);
    updateBillingSummary(billing);
    enableHydratedProfileForm();
    setProfileFeedback('');
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
    const ownerId = String(sessionUser?.userId || '');
    if (!ownerId) throw new Error('Unable to verify the profile account.');
    const profile = await getProfile({ expectedUserId: ownerId });
    if (profile?.userId !== ownerId) throw new Error('Unable to verify the profile account.');
    if (requestId !== profileHydrationRequestId
      || (requestedOwner && requestedOwner !== ownerId)
      || (observedProfileOwner && observedProfileOwner !== ownerId)) return false;
    observedProfileOwner ||= ownerId;
    hydratedProfileOwner = ownerId;
    const syncedUser = {
      name: profile.name || sessionUser?.name || 'Member',
      email: profile.email || sessionUser?.email || 'Logged in',
      avatarUrl: profile.avatarUrl || '',
      updatedAt: profile.updatedAt || '',
      profilePhotoAvailable: profile.profilePhotoAvailable,
      authenticated: true,
    };
    syncStoredUser(syncedUser);
    renderProfile(syncedUser);
    updateBillingSummary(billing);
    enableHydratedProfileForm();
    setProfileFeedback('');
    return true;
  } catch (error) {
    console.warn('Unable to load profile from Supabase', error);
    setProfileFeedback('Unable to load your profile right now.', 'error');
    return false;
  }
}

profilePhotoInput?.addEventListener('change', async () => {
  const preparationId = ++photoPreparationSequence;
  revokeSelectedPreview();
  selectedPhotoFile = null;
  selectedPreparedPhoto = null;
  renderPhotoSelection();

  const file = profilePhotoInput.files?.[0];
  if (!file) {
    renderAvatar(currentProfile);
    return;
  }

  selectedPhotoFile = file;
  renderPhotoSelection(file);
  setProfileFormBusy(true, 'Preparing...');
  setProfileFeedback(`Preparing “${file.name}” as a secure avatar thumbnail...`);
  try {
    const preparedPhoto = await prepareProfilePhoto(file);
    if (preparationId !== photoPreparationSequence || selectedPhotoFile !== file) return;
    selectedPreparedPhoto = preparedPhoto;
    selectedPreviewUrl = URL.createObjectURL(preparedPhoto.blob);
    renderAvatar({ ...currentProfile, avatarUrl: selectedPreviewUrl });
    setProfileFeedback(`“${file.name}” is ready as a ${preparedPhoto.width}×${preparedPhoto.height} thumbnail.`);
  } catch (error) {
    if (preparationId !== photoPreparationSequence) return;
    selectedPhotoFile = null;
    selectedPreparedPhoto = null;
    profilePhotoInput.value = '';
    renderPhotoSelection();
    renderAvatar(currentProfile);
    setProfileFeedback(error?.message || 'Unable to prepare that profile picture.', 'error');
  } finally {
    if (preparationId === photoPreparationSequence) setProfileFormBusy(false);
  }
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
  if (selectedPreparedPhoto && !profilePhotoAvailable) {
    setProfileFeedback('Profile pictures are temporarily unavailable while storage is upgraded.', 'error');
    return;
  }
  const mutationOwner = captureProfileOwner();
  if (!mutationOwner) return;

  setProfileFormBusy(true);
  setProfileFeedback(selectedPreparedPhoto ? 'Uploading profile thumbnail...' : 'Saving profile...');

  try {
    const textChanged = name !== (currentProfile.name || '') || email !== (currentProfile.email || '');
    let savedProfile;
    let cleanupError = null;
    if (selectedPreparedPhoto) {
      const result = await replaceProfilePhoto({
        preparedPhoto: selectedPreparedPhoto,
        profile: {
          ...(textChanged ? { name, email } : {}),
          avatarOnly: !textChanged,
          expectedUpdatedAt: currentProfile.updatedAt,
        },
      }, { expectedUserId: mutationOwner.userId });
      savedProfile = result.savedProfile;
      cleanupError = result.cleanupError;
    } else {
      savedProfile = await updateProfile({
        name,
        email,
        expectedUpdatedAt: currentProfile.updatedAt,
      }, { expectedUserId: mutationOwner.userId });
    }
    if (!isCurrentProfileOwner(mutationOwner)) return;
    const nextProfile = {
      name: savedProfile?.name || name,
      email: savedProfile?.email || email,
      avatarUrl: savedProfile?.avatarUrl || currentProfile.avatarUrl || '',
      updatedAt: savedProfile?.updatedAt || currentProfile.updatedAt || '',
      profilePhotoAvailable: savedProfile?.profilePhotoAvailable
        ?? currentProfile.profilePhotoAvailable,
    };

    selectedPhotoFile = null;
    selectedPreparedPhoto = null;
    if (profilePhotoInput) profilePhotoInput.value = '';
    revokeSelectedPreview();
    renderPhotoSelection();
    syncStoredUser(nextProfile);
    renderProfile(nextProfile);
    if (savedProfile?.emailChangeError) {
      setProfileFeedback('Profile saved, but the sign-in email could not be updated. Try that email change again.', 'error');
    } else if (cleanupError) {
      setProfileFeedback(cleanupError.message, 'error');
    } else {
      setProfileFeedback(savedProfile?.emailChangeRequested
        ? 'Profile saved. Confirm the email change from your inbox.'
        : 'Profile saved.');
    }
  } catch (error) {
    if (!isCurrentProfileOwner(mutationOwner)) return;
    renderAvatar(selectedPreviewUrl
      ? { ...currentProfile, avatarUrl: selectedPreviewUrl }
      : currentProfile);
    setProfileFeedback(error?.message || 'Unable to save your profile right now.', 'error');
  } finally {
    if (isCurrentProfileOwner(mutationOwner)) setProfileFormBusy(false, originalButtonLabel);
  }
});

profilePreviewChallengeSwitch?.addEventListener('change', () => {
  const owner = captureProfileOwner();
  if (!localPreviewMode || !owner || owner.userId !== currentPreviewOwnerId) return;
  previewChallengeState = setPreviewChallengeEnabled(
    previewChallengeState,
    profilePreviewChallengeSwitch.checked,
    localDateKey(),
  );
  saveCurrentPreviewValue(PREVIEW_CHALLENGE_STORAGE_KEY, previewChallengeState);
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
  if (localPreviewMode && event.key === 'dominion:user') {
    invalidateProfileOwner('');
    void getLocalOrSessionUser()
      .then((user) => {
        const nextOwner = String(user?.userId || '');
        if (!nextOwner) {
          redirectToLogin('./profile.html');
          return;
        }
        invalidateProfileOwner(nextOwner);
        return hydratePage(nextOwner);
      })
      .catch(() => redirectToLogin('./profile.html'));
    return;
  }
  if (!localPreviewMode || ![PREVIEW_CHALLENGE_STORAGE_KEY, PREVIEW_USER_STATE_STORAGE_KEY].includes(event.key)) return;
  loadCurrentPreviewChallengeState();
  renderPreviewChallengeTools();
});

renderPreviewChallengeTools();
async function hydratePage(expectedOwnerId = observedProfileOwner) {
  const authenticated = await hydrateProfile(expectedOwnerId);
  const owner = captureProfileOwner();
  const themeHydration = hydrateThemeOptions(owner);
  if (authenticated && owner) await hydrateIntegrationConsent(owner);
  await themeHydration;
}

async function bootProfilePage() {
  invalidateProfileOwner('');
  const currentUser = await getLocalOrSessionUser();
  const ownerId = String(currentUser?.userId || '');
  if (!ownerId) {
    redirectToLogin('./profile.html');
    return;
  }
  invalidateProfileOwner(ownerId);
  const unsubscribeAuth = subscribeToAuthStateChanges(({ user }) => {
    const nextOwner = String(user?.userId || '');
    invalidateProfileOwner(nextOwner);
    if (!nextOwner) {
      redirectToLogin('./profile.html');
      return;
    }
    void hydratePage(nextOwner);
  });
  window.addEventListener('pagehide', unsubscribeAuth, { once: true });
  await hydratePage(ownerId);
}
bootProfilePage().catch((error) => {
  console.warn('Unable to boot profile', error);
  invalidateProfileOwner('');
  setProfileFeedback('Unable to load your profile right now.', 'error');
});
initReveal();
