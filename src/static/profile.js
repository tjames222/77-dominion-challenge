import { initReveal } from './reveal';
import {
  getBillingState,
  getLocalOrSessionUser,
  getProfile,
  hasSupabaseAuth,
  isLocalDemoMode,
  redirectToLogin,
  removeReplacedProfilePhoto,
  removeUploadedProfilePhoto,
  updateProfile,
  uploadProfilePhoto,
} from './api';
import {
  prepareProfilePhoto,
  replaceProfilePhoto,
  validateProfilePhotoInput,
} from './profile-photo.mjs';
import {
  PREVIEW_CHALLENGE_RESET_KEYS,
  PREVIEW_CHALLENGE_STORAGE_KEY,
  isPreviewChallengeComplete,
  normalizePreviewChallengeState,
  previewChallengeDay,
  setPreviewChallengeEnabled,
} from './preview-challenge.mjs';

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
let theme = load('dominion:theme', 'dark');
const themeOptions = [...document.querySelectorAll('[data-theme-mode]')];
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  themeOptions.forEach((option) => {
    const isActive = option.dataset.themeMode === theme;
    option.classList.toggle('active', isActive);
    option.setAttribute('aria-pressed', String(isActive));
  });
}
themeOptions.forEach((option) => {
  option.addEventListener('click', () => {
    theme = option.dataset.themeMode || 'dark';
    save('dominion:theme', theme);
    applyTheme();
  });
});
applyTheme();

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
let currentProfile = { name: 'Member', email: 'Logged in', avatarUrl: '' };
let selectedPreparedPhoto = null;
let selectedPreviewUrl = '';
let photoProcessingPromise = null;
let photoSelectionVersion = 0;
let isPhotoProcessing = false;
let isProfileSaving = false;
const EMPTY_PHOTO_FILENAME = 'No new photo selected';
const profileSubmitButton = profileForm?.querySelector('button[type="submit"]');
const PROFILE_SUBMIT_LABEL = profileSubmitButton?.textContent || 'Save profile';
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

function syncProfileFormAvailability() {
  if (profilePhotoInput) profilePhotoInput.disabled = isProfileSaving;
  if (profilePhotoField) {
    profilePhotoField.setAttribute('aria-busy', String(isProfileSaving || isPhotoProcessing));
  }
  if (profileSubmitButton) {
    profileSubmitButton.disabled = isProfileSaving || isPhotoProcessing;
    profileSubmitButton.textContent = isProfileSaving
      ? 'Saving...'
      : isPhotoProcessing
        ? 'Preparing photo...'
        : PROFILE_SUBMIT_LABEL;
  }
}

function setProfileFormBusy(isBusy) {
  isProfileSaving = isBusy;
  syncProfileFormAvailability();
}

function setProfilePhotoProcessing(isProcessing) {
  isPhotoProcessing = isProcessing;
  syncProfileFormAvailability();
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

async function hydrateProfile() {
  if (!hasSupabaseAuth() && isLocalDemoMode()) {
    const user = load('dominion:user', { name: 'Member', email: 'Logged in', avatarUrl: '' });
    const billing = await getBillingState();
    if (!billing.authenticated) {
      redirectToLogin('./profile.html');
      return;
    }
    renderProfile(user);
    updateBillingSummary(billing);
    return;
  }

  if (!hasSupabaseAuth()) {
    redirectToLogin('./profile.html');
    return;
  }

  try {
    const billing = await getBillingState();
    if (!billing.authenticated) {
      redirectToLogin('./profile.html');
      return;
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
  } catch (error) {
    console.warn('Unable to load profile from Supabase', error);
    setProfileFeedback('Unable to load your profile right now.', 'error');
  }
}

profilePhotoInput?.addEventListener('change', async () => {
  const selectionVersion = ++photoSelectionVersion;
  photoProcessingPromise = null;
  setProfilePhotoProcessing(false);
  revokeSelectedPreview();
  selectedPreparedPhoto = null;
  renderPhotoSelection();

  const file = profilePhotoInput.files?.[0];
  if (!file) {
    renderAvatar(currentProfile);
    return;
  }

  try {
    validateProfilePhotoInput(file);
  } catch (error) {
    profilePhotoInput.value = '';
    setProfileFeedback(error?.message || 'Choose a valid profile picture.', 'error');
    renderAvatar(currentProfile);
    return;
  }

  renderPhotoSelection(file);
  renderAvatar(currentProfile);
  setProfilePhotoProcessing(true);
  setProfileFeedback(`Preparing “${file.name}” as a square thumbnail...`);
  const processingPromise = prepareProfilePhoto(file);
  photoProcessingPromise = processingPromise;

  try {
    const preparedPhoto = await processingPromise;
    if (selectionVersion !== photoSelectionVersion) return;
    selectedPreparedPhoto = preparedPhoto;
    selectedPreviewUrl = URL.createObjectURL(preparedPhoto.blob);
    renderAvatar({ ...currentProfile, avatarUrl: selectedPreviewUrl });
    const format = preparedPhoto.contentType === 'image/webp' ? 'WebP' : 'JPEG';
    const kilobytes = Math.max(1, Math.ceil(preparedPhoto.blob.size / 1024));
    setProfileFeedback(
      `“${file.name}” is ready as a ${preparedPhoto.width}×${preparedPhoto.height} ${format} thumbnail (${kilobytes} KB). Save profile when ready.`,
    );
  } catch (error) {
    if (selectionVersion !== photoSelectionVersion) return;
    profilePhotoInput.value = '';
    renderPhotoSelection();
    renderAvatar(currentProfile);
    setProfileFeedback(error?.message || 'Unable to prepare that profile picture.', 'error');
  } finally {
    if (selectionVersion === photoSelectionVersion) {
      photoProcessingPromise = null;
      setProfilePhotoProcessing(false);
    }
  }
});

profileForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = profileNameInput?.value.trim() || '';
  const email = profileEmailInput?.value.trim() || '';

  if (!name || !email) {
    setProfileFeedback('Name and email are required.', 'error');
    return;
  }

  if (photoProcessingPromise) {
    try {
      await photoProcessingPromise;
    } catch {
      return;
    }
  }

  setProfileFormBusy(true);
  setProfileFeedback(selectedPreparedPhoto ? 'Uploading profile thumbnail...' : 'Saving profile...');

  try {
    let avatarUrl = currentProfile.avatarUrl || '';
    let cleanupError = null;
    let savedProfile;
    if (selectedPreparedPhoto) {
      const replacement = await replaceProfilePhoto({
        preparedPhoto: selectedPreparedPhoto,
        previousAvatarUrl: currentProfile.avatarUrl,
        profile: { name, email },
        uploadPhoto: uploadProfilePhoto,
        saveProfile: updateProfile,
        removePreviousPhoto: removeReplacedProfilePhoto,
        removeUploadedPhoto: removeUploadedProfilePhoto,
      });
      savedProfile = replacement.savedProfile;
      avatarUrl = replacement.uploadedPhoto.avatarUrl;
      cleanupError = replacement.cleanupError;
    } else {
      // Do not resubmit a cached avatar when this save only changes text fields;
      // another tab may have replaced that photo since this form was hydrated.
      savedProfile = await updateProfile({ name, email });
    }
    const nextProfile = {
      name: savedProfile?.name || name,
      email: savedProfile?.email || email,
      avatarUrl: savedProfile?.avatarUrl || avatarUrl,
    };

    selectedPreparedPhoto = null;
    if (profilePhotoInput) profilePhotoInput.value = '';
    revokeSelectedPreview();
    renderPhotoSelection();
    syncStoredUser(nextProfile);
    renderProfile(nextProfile);
    if (cleanupError) {
      console.warn('Unable to remove the previous profile photo', cleanupError);
      setProfileFeedback('Profile saved, but the previous stored photo could not be removed. Try again later.', 'error');
    } else if (savedProfile?.metadataSyncError) {
      console.warn('Unable to sync profile display metadata to Auth', savedProfile.metadataSyncError);
      setProfileFeedback('Profile saved, but account display metadata could not finish syncing. Try saving again.', 'error');
    } else {
      setProfileFeedback(savedProfile?.emailChangeRequested
        ? 'Profile saved. Confirm the email change from your inbox.'
        : 'Profile saved.');
    }
  } catch (error) {
    if (error?.profilePhotoRollbackUnsafe) {
      console.warn('Profile photo commit could not be verified; the uploaded object was retained', error);
    }
    if (error?.profilePhotoRollbackError) {
      console.warn('Unable to roll back the uncommitted profile photo', error.profilePhotoRollbackError);
    }
    renderAvatar(selectedPreviewUrl
      ? { ...currentProfile, avatarUrl: selectedPreviewUrl }
      : currentProfile);
    setProfileFeedback(error?.message || 'Unable to save your profile right now.', 'error');
  } finally {
    setProfileFormBusy(false);
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

window.addEventListener('storage', (event) => {
  if (!localPreviewMode || event.key !== PREVIEW_CHALLENGE_STORAGE_KEY) return;
  previewChallengeState = normalizePreviewChallengeState(
    load(PREVIEW_CHALLENGE_STORAGE_KEY, {}),
    localDateKey(),
  );
  renderPreviewChallengeTools();
});

renderPreviewChallengeTools();
hydrateProfile();
initReveal();
