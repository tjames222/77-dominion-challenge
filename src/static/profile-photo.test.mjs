import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  PROFILE_PHOTO_MAX_INPUT_BYTES,
  PROFILE_PHOTO_MAX_OUTPUT_BYTES,
  calculateProfilePhotoCrop,
  commitProfilePhotoWithCompareAndSwap,
  decodeProfilePhoto,
  isPreparedProfilePhoto,
  ownedProfilePhotoPathFromUrl,
  prepareProfilePhoto,
  replaceProfilePhoto,
  syncProfileMetadataBestEffort,
  validateProfilePhotoInput,
} from './profile-photo.mjs';

const fakeFile = ({ name = 'photo.jpg', type = 'image/jpeg', size = 4_096 } = {}) => ({
  name,
  type,
  size,
});

const sizedBlob = (size, type) => new Blob([new Uint8Array(size)], { type });

function canvasRecorder() {
  const canvases = [];
  const createCanvas = (width, height) => {
    const operations = [];
    const context = {
      clearRect: (...args) => operations.push(['clearRect', ...args]),
      drawImage: (...args) => operations.push(['drawImage', ...args]),
      fillRect: (...args) => operations.push(['fillRect', ...args]),
      set fillStyle(value) {
        operations.push(['fillStyle', value]);
      },
    };
    const canvas = {
      width,
      height,
      getContext: (_kind, options) => {
        operations.push(['getContext', options]);
        return context;
      },
    };
    canvases.push({ canvas, operations });
    return canvas;
  };
  return { canvases, createCanvas };
}

async function makePreparedPhoto(overrides = {}) {
  const recorder = canvasRecorder();
  const file = fakeFile(overrides.file);
  const prepared = await prepareProfilePhoto(file, {
    decodeImage: async () => ({ width: 900, height: 600 }),
    createCanvas: recorder.createCanvas,
    encodeCanvas: async (_canvas, type) => sizedBlob(32_000, type),
    ...overrides.options,
  });
  return { file, prepared, recorder };
}

test('center crop handles portrait, landscape, square, and small images without upscaling', () => {
  assert.deepEqual(calculateProfilePhotoCrop(800, 1200), {
    sourceX: 0,
    sourceY: 200,
    sourceSize: 800,
    width: 256,
    height: 256,
  });
  assert.deepEqual(calculateProfilePhotoCrop(1200, 800), {
    sourceX: 200,
    sourceY: 0,
    sourceSize: 800,
    width: 256,
    height: 256,
  });
  assert.deepEqual(calculateProfilePhotoCrop(400, 400), {
    sourceX: 0,
    sourceY: 0,
    sourceSize: 400,
    width: 256,
    height: 256,
  });
  assert.deepEqual(calculateProfilePhotoCrop(80, 120), {
    sourceX: 0,
    sourceY: 20,
    sourceSize: 80,
    width: 80,
    height: 80,
  });
});

test('decoded orientation is normalized before the center crop is drawn without stretching', async () => {
  const calls = [];
  const bitmap = { width: 1200, height: 800, close: () => calls.push(['close']) };
  const decoded = await decodeProfilePhoto(fakeFile(), {
    createImageBitmapFn: async (...args) => {
      calls.push(args);
      return bitmap;
    },
  });
  assert.equal(decoded, bitmap);
  assert.deepEqual(calls[0][1], { imageOrientation: 'from-image' });

  const recorder = canvasRecorder();
  const prepared = await prepareProfilePhoto(fakeFile(), {
    decodeImage: async () => bitmap,
    createCanvas: recorder.createCanvas,
    encodeCanvas: async (_canvas, type) => sizedBlob(24_000, type),
  });
  assert.equal(prepared.width, 256);
  assert.equal(prepared.height, 256);
  const draw = recorder.canvases[0].operations.find(([name]) => name === 'drawImage');
  assert.deepEqual(draw.slice(2), [200, 0, 800, 800, 0, 0, 256, 256]);
  assert.equal(calls.filter(([name]) => name === 'close').length, 1);
});

test('WebP is preferred and preserves a transparent canvas', async () => {
  const { prepared, recorder } = await makePreparedPhoto();
  assert.equal(prepared.contentType, 'image/webp');
  assert.equal(prepared.extension, 'webp');
  assert.equal(isPreparedProfilePhoto(prepared), true);
  assert.equal(recorder.canvases[0].operations.some(([name]) => name === 'fillRect'), false);
});

test('JPEG fallback fills transparency and stays within the payload limit', async () => {
  const { prepared, recorder } = await makePreparedPhoto({
    options: {
      encodeCanvas: async (_canvas, type) => type === 'image/webp'
        ? sizedBlob(20_000, 'image/png')
        : sizedBlob(PROFILE_PHOTO_MAX_OUTPUT_BYTES, 'image/jpeg'),
    },
  });
  assert.equal(prepared.contentType, 'image/jpeg');
  assert.equal(prepared.blob.size, PROFILE_PHOTO_MAX_OUTPUT_BYTES);
  const jpegCanvas = recorder.canvases.find(({ operations }) => (
    operations.some(([name, options]) => name === 'getContext' && options?.alpha === false)
  ));
  assert.ok(jpegCanvas);
  assert.ok(jpegCanvas.operations.some(([name]) => name === 'fillRect'));
});

test('compression reduces quality until the thumbnail is at most 150 KB', async () => {
  const attemptedQualities = [];
  const { prepared } = await makePreparedPhoto({
    options: {
      encodeCanvas: async (_canvas, type, quality) => {
        attemptedQualities.push(quality);
        const size = quality > 0.58 ? PROFILE_PHOTO_MAX_OUTPUT_BYTES + 1 : 96_000;
        return sizedBlob(size, type);
      },
    },
  });
  assert.deepEqual(attemptedQualities, [0.88, 0.82, 0.76, 0.68, 0.58]);
  assert.equal(prepared.blob.size, 96_000);
  assert.ok(prepared.blob.size <= PROFILE_PHOTO_MAX_OUTPUT_BYTES);
});

test('an image that cannot reach the payload limit fails before upload', async () => {
  await assert.rejects(
    makePreparedPhoto({
      options: {
        encodeCanvas: async (_canvas, type) => sizedBlob(PROFILE_PHOTO_MAX_OUTPUT_BYTES + 1, type),
      },
    }),
    /compress.*150 KB/i,
  );
});

test('invalid and oversized inputs are rejected with input guidance', () => {
  assert.throws(
    () => validateProfilePhotoInput(fakeFile({ name: 'animation.gif', type: 'image/gif' })),
    /JPG, PNG, WebP, HEIC, or HEIF/,
  );
  assert.throws(
    () => validateProfilePhotoInput(fakeFile({ size: PROFILE_PHOTO_MAX_INPUT_BYTES + 1 })),
    /smaller than 5 MB/,
  );
  assert.throws(
    () => validateProfilePhotoInput(fakeFile({ size: 0 })),
    /empty/,
  );
});

test('unsupported HEIC decoding returns an actionable conversion error', async () => {
  await assert.rejects(
    prepareProfilePhoto(fakeFile({ name: 'portrait.heic', type: 'image/heic' }), {
      decodeImage: async () => { throw new Error('decoder unavailable'); },
    }),
    /Export the photo as JPG or PNG/,
  );
});

test('successful replacement saves the new URL before removing the previous object', async () => {
  const { prepared } = await makePreparedPhoto();
  const events = [];
  const result = await replaceProfilePhoto({
    preparedPhoto: prepared,
    previousAvatarUrl: 'https://project.test/storage/v1/object/public/profile-photos/user-1/avatar-1.jpg',
    profile: { name: 'Member', email: 'member@example.com' },
    uploadPhoto: async (photo) => {
      events.push(['upload', photo]);
      return { avatarUrl: 'https://project.test/new.webp', storagePath: 'user-1/avatar-2.webp' };
    },
    saveProfile: async (profile) => {
      events.push(['save', profile]);
      return profile;
    },
    removePreviousPhoto: async (...args) => events.push(['removePrevious', ...args]),
    removeUploadedPhoto: async (...args) => events.push(['rollback', ...args]),
  });

  assert.deepEqual(events.map(([name]) => name), ['upload', 'save', 'removePrevious']);
  assert.equal(events[0][1], prepared);
  assert.equal(events[1][1].avatarUrl, 'https://project.test/new.webp');
  assert.equal(result.savedProfile.avatarUrl, 'https://project.test/new.webp');
  assert.equal(result.cleanupError, null);
});

test('concurrent replacements retry against and clean the actual canonical predecessor', async () => {
  let canonicalProfile = { avatarUrl: 'avatar-a' };
  const attemptedUrls = [];
  const result = await commitProfilePhotoWithCompareAndSwap({
    expectedAvatarUrl: 'avatar-a',
    newAvatarUrl: 'avatar-c',
    trySwap: async (expectedAvatarUrl) => {
      attemptedUrls.push(expectedAvatarUrl);
      if (attemptedUrls.length === 1) {
        canonicalProfile = { avatarUrl: 'avatar-b' };
        return null;
      }
      if (canonicalProfile.avatarUrl !== expectedAvatarUrl) return null;
      canonicalProfile = { avatarUrl: 'avatar-c' };
      return canonicalProfile;
    },
    readCurrentProfile: async () => canonicalProfile,
  });

  assert.deepEqual(attemptedUrls, ['avatar-a', 'avatar-b']);
  assert.equal(result.savedProfile.avatarUrl, 'avatar-c');
  assert.equal(result.replacedAvatarUrl, 'avatar-b');
});

test('a committed compare-and-swap survives a lost response without deleting the canonical object', async () => {
  const result = await commitProfilePhotoWithCompareAndSwap({
    expectedAvatarUrl: 'avatar-a',
    newAvatarUrl: 'avatar-b',
    trySwap: async () => { throw new Error('response lost'); },
    readCurrentProfile: async () => ({ avatarUrl: 'avatar-b' }),
  });
  assert.equal(result.savedProfile.avatarUrl, 'avatar-b');
  assert.equal(result.replacedAvatarUrl, 'avatar-a');
});

test('an unverifiable compare-and-swap retains the upload for a safe reload', async () => {
  await assert.rejects(
    commitProfilePhotoWithCompareAndSwap({
      expectedAvatarUrl: 'avatar-a',
      newAvatarUrl: 'avatar-b',
      trySwap: async () => { throw new Error('response lost'); },
      readCurrentProfile: async () => { throw new Error('offline'); },
    }),
    (error) => error.profilePhotoRollbackUnsafe === true && /retained.*reload/i.test(error.message),
  );
});

test('replacement cleanup uses the predecessor returned by the canonical compare-and-swap', async () => {
  const { prepared } = await makePreparedPhoto();
  const removed = [];
  await replaceProfilePhoto({
    preparedPhoto: prepared,
    previousAvatarUrl: 'stale-avatar-a',
    profile: {},
    uploadPhoto: async () => ({ avatarUrl: 'avatar-c', storagePath: 'user-1/avatar-c.webp' }),
    saveProfile: async () => ({ avatarUrl: 'avatar-c', replacedAvatarUrl: 'actual-avatar-b' }),
    removePreviousPhoto: async (avatarUrl) => removed.push(avatarUrl),
    removeUploadedPhoto: async () => {},
  });
  assert.deepEqual(removed, ['actual-avatar-b']);
});

test('upload failure leaves the existing profile and object untouched', async () => {
  const { prepared } = await makePreparedPhoto();
  const events = [];
  await assert.rejects(
    replaceProfilePhoto({
      preparedPhoto: prepared,
      previousAvatarUrl: 'old-url',
      profile: {},
      uploadPhoto: async () => {
        events.push('upload');
        throw new Error('upload failed');
      },
      saveProfile: async () => events.push('save'),
      removePreviousPhoto: async () => events.push('removePrevious'),
      removeUploadedPhoto: async () => events.push('rollback'),
    }),
    /upload failed/,
  );
  assert.deepEqual(events, ['upload']);
});

test('profile update failure rolls back only the new object and preserves the previous one', async () => {
  const { prepared } = await makePreparedPhoto();
  const events = [];
  await assert.rejects(
    replaceProfilePhoto({
      preparedPhoto: prepared,
      previousAvatarUrl: 'old-url',
      profile: {},
      uploadPhoto: async () => {
        events.push('upload');
        return { avatarUrl: 'new-url', storagePath: 'user-1/avatar-2.webp' };
      },
      saveProfile: async () => {
        events.push('save');
        throw new Error('profile failed');
      },
      removePreviousPhoto: async () => events.push('removePrevious'),
      removeUploadedPhoto: async () => events.push('rollback'),
    }),
    /profile failed/,
  );
  assert.deepEqual(events, ['upload', 'save', 'rollback']);
});

test('an ambiguous profile commit never deletes the possibly canonical upload', async () => {
  const { prepared } = await makePreparedPhoto();
  const events = [];
  const uncertainError = Object.assign(new Error('commit unknown'), {
    profilePhotoRollbackUnsafe: true,
  });
  await assert.rejects(
    replaceProfilePhoto({
      preparedPhoto: prepared,
      previousAvatarUrl: 'old-url',
      profile: {},
      uploadPhoto: async () => {
        events.push('upload');
        return { avatarUrl: 'new-url', storagePath: 'user-1/avatar-2.webp' };
      },
      saveProfile: async () => {
        events.push('save');
        throw uncertainError;
      },
      removePreviousPhoto: async () => events.push('removePrevious'),
      removeUploadedPhoto: async () => events.push('rollback'),
    }),
    (error) => error === uncertainError,
  );
  assert.deepEqual(events, ['upload', 'save']);
});

test('cleanup failures do not hide a successfully saved replacement', async () => {
  const { prepared } = await makePreparedPhoto();
  const cleanupFailure = new Error('remove failed');
  const result = await replaceProfilePhoto({
    preparedPhoto: prepared,
    previousAvatarUrl: 'old-url',
    profile: {},
    uploadPhoto: async () => ({ avatarUrl: 'new-url', storagePath: 'user-1/avatar-2.webp' }),
    saveProfile: async (profile) => profile,
    removePreviousPhoto: async () => { throw cleanupFailure; },
    removeUploadedPhoto: async () => {},
  });
  assert.equal(result.savedProfile.avatarUrl, 'new-url');
  assert.equal(result.cleanupError, cleanupFailure);
});

test('the canonical profile row permits cleanup when the Auth metadata mirror fails', async () => {
  const { prepared } = await makePreparedPhoto();
  const events = [];
  const result = await replaceProfilePhoto({
    preparedPhoto: prepared,
    previousAvatarUrl: 'old-url',
    profile: {},
    uploadPhoto: async () => {
      events.push('upload');
      return { avatarUrl: 'new-url', storagePath: 'user-1/avatar-2.webp' };
    },
    saveProfile: async () => {
      events.push('save');
      return {
        avatarUrl: 'new-url',
        metadataSyncError: new Error('metadata unavailable'),
      };
    },
    removePreviousPhoto: async () => events.push('removePrevious'),
    removeUploadedPhoto: async () => events.push('rollback'),
  });

  assert.deepEqual(events, ['upload', 'save', 'removePrevious']);
  assert.equal(result.cleanupError, null);
});

test('best-effort Auth metadata failures never reject after the canonical photo commit', async () => {
  const returnedError = new Error('Auth returned an error');
  assert.equal(
    await syncProfileMetadataBestEffort(async () => ({ error: returnedError }), {}),
    returnedError,
  );

  const thrownError = new Error('Auth storage failed');
  assert.equal(
    await syncProfileMetadataBestEffort(async () => { throw thrownError; }, {}),
    thrownError,
  );
  assert.equal(
    await syncProfileMetadataBestEffort(async () => ({ error: null }), {}),
    null,
  );
});

test('replacement cleanup only accepts legacy or new objects in the signed-in user folder', () => {
  const base = 'https://project.supabase.co/storage/v1/object/public/profile-photos/';
  assert.equal(
    ownedProfilePhotoPathFromUrl(
      `${base}user-1/avatar-1720000000000.jpg?cache=1`,
      'user-1',
      'profile-photos',
      'https://project.supabase.co',
    ),
    'user-1/avatar-1720000000000.jpg',
  );
  assert.equal(
    ownedProfilePhotoPathFromUrl(`${base}user-1/avatar-1720000000000-deadbeef.webp`, 'user-1'),
    'user-1/avatar-1720000000000-deadbeef.webp',
  );
  assert.equal(ownedProfilePhotoPathFromUrl(`${base}user-2/avatar-1.jpg`, 'user-1'), '');
  assert.equal(ownedProfilePhotoPathFromUrl(`${base}user-1/nested/avatar-1.jpg`, 'user-1'), '');
  assert.equal(ownedProfilePhotoPathFromUrl('https://attacker.test/avatar-1.jpg', 'user-1'), '');
  assert.equal(
    ownedProfilePhotoPathFromUrl(
      'https://attacker.test/storage/v1/object/public/profile-photos/user-1/avatar-1.jpg',
      'user-1',
      'profile-photos',
      'https://project.supabase.co',
    ),
    '',
  );
  assert.equal(ownedProfilePhotoPathFromUrl(`${base}user-1/%2e%2e`, 'user-1'), '');
});

test('the storage API uploads only the prepared blob and uses immutable object paths', () => {
  const apiSource = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
  const profileSource = readFileSync(new URL('./profile.js', import.meta.url), 'utf8');
  assert.match(apiSource, /\.upload\(storagePath, preparedPhoto\.blob,/);
  assert.match(apiSource, /contentType: preparedPhoto\.contentType/);
  assert.match(apiSource, /upsert: false/);
  assert.doesNotMatch(apiSource, /uploadProfilePhoto\(file\)/);
  assert.ok(
    apiSource.indexOf('savedProfile = await upsertProfile')
      < apiSource.indexOf('metadataSyncError = await syncProfileMetadataBestEffort'),
    'canonical profile row must commit before Auth display metadata',
  );
  assert.ok(
    apiSource.indexOf('const swapResult = await commitProfilePhotoWithCompareAndSwap')
      < apiSource.indexOf('metadataSyncError = await syncProfileMetadataBestEffort'),
    'canonical avatar swap must commit before Auth metadata cleanup',
  );
  assert.match(profileSource, /savedProfile = await updateProfile\(\{ name, email \}\);/);
  assert.doesNotMatch(profileSource, /updateProfile\(\{ name, email, avatarUrl \}\)/);
  assert.match(apiSource, /\.eq\('avatar_url', expectedAvatarUrl\)/);
  assert.match(apiSource, /\.update\(\{ avatar_url: profile\.avatarUrl \|\| '' \}\)/);
  assert.doesNotMatch(apiSource, /dataUpdates\.avatar_url = profile\.avatarUrl/);
  assert.match(apiSource, /return \{ name, email, avatarUrl: '', authenticated:/);
  assert.match(apiSource, /metadataSyncError = await syncProfileMetadataBestEffort/);
});

test('fresh and existing Supabase environments enforce thumbnail-only storage', () => {
  const schemaSource = readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8');
  const migrationSource = readFileSync(
    new URL('../../supabase/migrations/20260721022558_harden_profile_photo_thumbnails.sql', import.meta.url),
    'utf8',
  );
  const expectedBucket = /'profile-photos',\s*'profile-photos',\s*true,\s*153600,\s*array\['image\/jpeg', 'image\/webp'\]/;

  assert.match(schemaSource, expectedBucket);
  assert.match(migrationSource, expectedBucket);
  assert.match(migrationSource, /add column if not exists avatar_url/);
  assert.match(migrationSource, /create trigger enforce_owned_profile_avatar_url/);
  assert.match(migrationSource, /auth\.jwt\(\) ->> 'iss'/);
  assert.match(migrationSource, /from storage\.objects[\s\S]*bucket_id = 'profile-photos'/);
  assert.match(schemaSource, /create trigger enforce_owned_profile_avatar_url/);
  assert.match(
    migrationSource,
    /revoke update on public\.profiles from authenticated;\s*grant update \(user_id, name, email, avatar_url, challenge_start_date\)\s*on public\.profiles to authenticated/,
  );
  assert.doesNotMatch(schemaSource, /create policy "Profile photos are publicly readable"/);
  assert.doesNotMatch(schemaSource, /create policy "Users can update own profile photo objects"/);
  assert.match(schemaSource, /create policy "Users can upload own profile photo objects"/);
  assert.match(schemaSource, /create policy "Users can delete own profile photo objects"/);
});
