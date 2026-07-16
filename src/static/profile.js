import { initReveal } from './reveal';
import {
  createCustomerPortalSession,
  getBillingState,
  getLocalOrSessionUser,
  getProfile,
  hasSupabaseAuth,
  isLocalDemoMode,
  redirectToLogin,
  updateProfile,
  uploadProfilePhoto,
} from './api';

const load = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
};
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
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
const manageBillingButton = document.getElementById('profileManageBillingButton');
const MAX_PROFILE_PHOTO_SIZE = 5 * 1024 * 1024;
let currentProfile = { name: 'Member', email: 'Logged in', avatarUrl: '' };
let selectedPhotoFile = null;
let selectedPreviewUrl = '';
const EMPTY_PHOTO_FILENAME = 'No new photo selected';

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
  manageBillingButton.hidden = !state.subscription;
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

manageBillingButton?.addEventListener('click', async () => {
  if (!hasSupabaseAuth() && !isLocalDemoMode()) return;
  const original = manageBillingButton.textContent;
  manageBillingButton.disabled = true;
  manageBillingButton.textContent = 'Opening...';
  try {
    const { url } = await createCustomerPortalSession();
    window.location.href = url;
  } catch (error) {
    window.alert(error?.message || 'Unable to open the billing portal right now.');
    manageBillingButton.disabled = false;
    manageBillingButton.textContent = original;
  }
});

hydrateProfile();
initReveal();
