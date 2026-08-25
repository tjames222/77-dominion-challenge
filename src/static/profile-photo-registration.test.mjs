import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProfilePhotoRegistrationError,
  isAmbiguousProfilePhotoRegistrationFailure,
  registerProfilePhotoUploadWithRetry,
} from './profile-photo-registration.mjs';

const storagePath = '10000000-0000-4000-8000-000000000001/avatar-1720000000000-0123456789abcdef0123456789abcdef.webp';

const transportFailure = (message = 'TypeError: Failed to fetch') => ({
  data: null,
  error: { code: '', message, details: '', hint: '' },
  status: 0,
  statusText: '',
});

test('registration retries one ambiguous transport failure with the exact same path', async () => {
  const paths = [];
  const registrationId = await registerProfilePhotoUploadWithRetry({
    storagePath,
    register: async (targetStoragePath) => {
      paths.push(targetStoragePath);
      return paths.length === 1
        ? transportFailure()
        : { data: 'registration-id', error: null, status: 200 };
    },
  });

  assert.equal(registrationId, 'registration-id');
  assert.deepEqual(paths, [storagePath, storagePath]);
});

test('registration retries a thrown fetch failure once, but not an unrelated exception', async () => {
  let fetchAttempts = 0;
  const registrationId = await registerProfilePhotoUploadWithRetry({
    storagePath,
    register: async () => {
      fetchAttempts += 1;
      if (fetchAttempts === 1) throw new TypeError('Failed to fetch');
      return { data: 'existing-registration-id', error: null, status: 200 };
    },
  });
  assert.equal(registrationId, 'existing-registration-id');
  assert.equal(fetchAttempts, 2);

  let applicationAttempts = 0;
  const applicationError = new TypeError('Registration response was malformed');
  await assert.rejects(registerProfilePhotoUploadWithRetry({
    storagePath,
    register: async () => {
      applicationAttempts += 1;
      throw applicationError;
    },
  }), (error) => error === applicationError);
  assert.equal(applicationAttempts, 1);
});

test('a second ambiguous transport failure is returned without a third attempt', async () => {
  let attempts = 0;
  await assert.rejects(registerProfilePhotoUploadWithRetry({
    storagePath,
    register: async () => {
      attempts += 1;
      return transportFailure('Network request failed');
    },
  }), /Network request failed/);
  assert.equal(attempts, 2);
});

test('only explicitly ambiguous gateway responses without an application code retry', async () => {
  for (const status of [502, 503, 504, 520, 521, 522, 523, 524]) {
    let attempts = 0;
    const registrationId = await registerProfilePhotoUploadWithRetry({
      storagePath,
      register: async () => {
        attempts += 1;
        return attempts === 1
          ? { data: null, error: { code: '', message: 'Gateway unavailable' }, status }
          : { data: `registration-${status}`, error: null, status: 200 };
      },
    });
    assert.equal(registrationId, `registration-${status}`);
    assert.equal(attempts, 2);
  }

  for (const response of [
    { data: null, error: { code: '', message: 'Too many requests' }, status: 429 },
    { data: null, error: { code: '', message: 'Internal error' }, status: 500 },
    { data: null, error: { code: 'PGRST002', message: 'Schema unavailable' }, status: 503 },
  ]) {
    let attempts = 0;
    await assert.rejects(registerProfilePhotoUploadWithRetry({
      storagePath,
      register: async () => {
        attempts += 1;
        return response;
      },
    }));
    assert.equal(attempts, 1);
  }
});

test('rate and capacity SQL errors are actionable and are never retried', async () => {
  const cases = [
    ['P8001', /still pending.*finish or expire/i],
    ['P8002', /cleanup.*catching up.*few minutes/i],
    ['P8003', /hourly.*try again later/i],
    ['P8004', /daily.*try again tomorrow/i],
  ];

  for (const [code, expectedMessage] of cases) {
    let attempts = 0;
    const databaseError = { code, message: 'Internal database limit detail' };
    await assert.rejects(registerProfilePhotoUploadWithRetry({
      storagePath,
      register: async () => {
        attempts += 1;
        return { data: null, error: databaseError, status: 400 };
      },
    }), (error) => {
      assert.match(error.message, expectedMessage);
      assert.equal(error.code, code);
      assert.equal(error.cause, databaseError);
      assert.equal(error.profilePhotoRegistrationLimit, true);
      return true;
    });
    assert.equal(attempts, 1);
  }
});

test('RPC application errors remain non-retryable even with a status-zero response', async () => {
  const databaseError = { code: '55000', message: 'Profile assets are frozen.' };
  let attempts = 0;
  await assert.rejects(registerProfilePhotoUploadWithRetry({
    storagePath,
    register: async () => {
      attempts += 1;
      return { data: null, error: databaseError, status: 0 };
    },
  }), /Profile assets are frozen/);
  assert.equal(attempts, 1);
  assert.equal(isAmbiguousProfilePhotoRegistrationFailure({
    error: databaseError,
    status: 0,
  }), false);
});

test('rate and capacity mapping is based on SQLSTATE, not mutable database text', () => {
  const error = createProfilePhotoRegistrationError({
    code: 'P8003',
    message: 'A database message that may change independently.',
  });
  assert.equal(
    error.message,
    'You have reached the hourly profile-picture upload limit. Try again later.',
  );
});
