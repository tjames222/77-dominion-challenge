import { getLocalOrSessionUser, submitEarlyAccessRequest, subscribeToAuthStateChanges } from './api';
import { EARLY_ACCESS_RECEIVED } from './early-access-request.mjs';
import { RELEASE_GATES } from './release-gates.mjs';
import '../assets/early-access.css';

const section = document.getElementById('early-access');
const form = document.getElementById('earlyAccessForm');
if (section && form) {
  section.hidden = RELEASE_GATES.billingEnabled && !RELEASE_GATES.mocksEnabled;
  document.querySelectorAll('[data-early-access-cta]').forEach((cta) => { cta.hidden = section.hidden; });
  const name = form.elements.namedItem('name');
  const email = form.elements.namedItem('email');
  const submit = form.querySelector('button[type="submit"]');
  const status = document.getElementById('earlyAccessStatus');
  const error = document.getElementById('earlyAccessError');
  const retry = document.getElementById('earlyAccessRetry');
  let actorId = '';
  let actorEmail = '';
  let hydrated = false;
  let epoch = 0;
  let busy = false;
  let suspended = false;
  const setBusy = (value) => {
    busy = value;
    form.setAttribute('aria-busy', String(value));
    submit.disabled = value;
    submit.textContent = value ? 'Sending request…' : 'Request early access';
  };
  const hydrate = async ({ clear = false } = {}) => {
    if (suspended) return;
    const generation = ++epoch;
    if (clear) {
      form.reset();
      status.textContent = '';
      error.textContent = '';
      form.hidden = true;
      setBusy(false);
      hydrated = false;
    }
    retry.hidden = true;
    let user;
    try {
      user = await getLocalOrSessionUser();
    } catch {
      if (generation !== epoch) return;
      form.hidden = true;
      hydrated = false;
      error.textContent = 'We couldn’t check your account. Please try loading the form again.';
      retry.hidden = false;
      return;
    }
    if (generation !== epoch) return;
    actorId = user?.authenticated ? user.userId : '';
    actorEmail = actorId ? (user.email || '') : '';
    if (actorId) {
      if (!name.value) name.value = user.name || '';
      email.value = user.email || '';
    }
    email.readOnly = Boolean(actorId);
    hydrated = true;
    error.textContent = '';
    form.hidden = false;
  };
  const unsubscribeAuthState = subscribeToAuthStateChanges(({ user }) => {
    const nextId = user?.authenticated ? user.userId : '';
    const nextEmail = nextId ? (user.email || '') : '';
    if (nextId !== actorId || nextEmail !== actorEmail) void hydrate({ clear: true });
  });
  window.addEventListener('storage', (event) => {
    if (event.key === 'dominion:user' || event.key === null) void hydrate({ clear: true });
  });
  window.addEventListener('pagehide', () => {
    suspended = true;
    epoch += 1;
    hydrated = false;
    actorId = '';
    actorEmail = '';
    form.reset();
    email.readOnly = false;
    form.hidden = true;
    status.textContent = '';
    error.textContent = '';
    retry.hidden = true;
    setBusy(false);
    unsubscribeAuthState();
  });
  window.addEventListener('pageshow', (event) => {
    // A restored document must re-check the current account before any form
    // state becomes visible. Never reuse the identity from its cached lifetime.
    if (event.persisted) window.location.reload();
  });
  retry.addEventListener('click', () => void hydrate());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !hydrated || !form.reportValidity()) return;
    const generation = epoch;
    error.textContent = '';
    status.textContent = 'Sending your request…';
    setBusy(true);
    try {
      const result = await submitEarlyAccessRequest({
        name: name.value, email: email.value, website: form.elements.namedItem('website').value,
      }, { expectedUserId: actorId });
      if (generation !== epoch) return;
      status.textContent = result.preview
        ? 'Preview request saved in this browser only. No real request or email was sent.'
        : EARLY_ACCESS_RECEIVED;
      form.hidden = true;
      status.focus();
    } catch (failure) {
      if (generation !== epoch) return;
      status.textContent = '';
      error.textContent = failure.message;
    } finally {
      if (generation === epoch) setBusy(false);
    }
  });
  void hydrate();
}
