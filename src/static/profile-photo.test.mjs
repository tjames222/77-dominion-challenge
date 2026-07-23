import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  PROFILE_PHOTO_MAX_INPUT_BYTES,
  PROFILE_PHOTO_MAX_OUTPUT_BYTES,
  calculateProfilePhotoCrop,
  canonicalProfilePhotoUrl,
  commitProfileUpdateWithCompareAndSwap,
  createProfilePhotoStoragePath,
  decodeProfilePhoto,
  isNewProfilePhotoPath,
  isPreparedProfilePhoto,
  ownedProfilePhotoPathFromUrl,
  prepareProfilePhoto,
  replaceProfilePhoto,
  validateProfilePhotoInput,
} from './profile-photo.mjs';

const fakeFile = ({ name = 'photo.jpg', type = 'image/jpeg', size = 4096 } = {}) => ({
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
      set fillStyle(value) { operations.push(['fillStyle', value]); },
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
  const prepared = await prepareProfilePhoto(fakeFile(overrides.file), {
    decodeImage: async () => ({ width: 900, height: 600 }),
    createCanvas: recorder.createCanvas,
    encodeCanvas: async (_canvas, type) => sizedBlob(32000, type),
    ...overrides.options,
  });
  return { prepared, recorder };
}

test('center crop handles portrait, landscape, square, and small images without upscaling', () => {
  assert.deepEqual(calculateProfilePhotoCrop(800, 1200), {
    sourceX: 0, sourceY: 200, sourceSize: 800, width: 256, height: 256,
  });
  assert.deepEqual(calculateProfilePhotoCrop(1200, 800), {
    sourceX: 200, sourceY: 0, sourceSize: 800, width: 256, height: 256,
  });
  assert.deepEqual(calculateProfilePhotoCrop(400, 400), {
    sourceX: 0, sourceY: 0, sourceSize: 400, width: 256, height: 256,
  });
  assert.deepEqual(calculateProfilePhotoCrop(80, 120), {
    sourceX: 0, sourceY: 20, sourceSize: 80, width: 80, height: 80,
  });
});

test('decoded EXIF orientation is normalized before a non-stretched crop is drawn', async () => {
  const calls = [];
  const bitmap = { width: 1200, height: 800, close: () => calls.push(['close']) };
  assert.equal(await decodeProfilePhoto(fakeFile(), {
    createImageBitmapFn: async (...args) => {
      calls.push(args);
      return bitmap;
    },
  }), bitmap);
  assert.deepEqual(calls[0][1], { imageOrientation: 'from-image' });

  const recorder = canvasRecorder();
  const prepared = await prepareProfilePhoto(fakeFile(), {
    decodeImage: async () => bitmap,
    createCanvas: recorder.createCanvas,
    encodeCanvas: async (_canvas, type) => sizedBlob(24000, type),
  });
  const draw = recorder.canvases[0].operations.find(([name]) => name === 'drawImage');
  assert.deepEqual(draw.slice(2), [200, 0, 800, 800, 0, 0, 256, 256]);
  assert.equal(prepared.width, prepared.height);
  assert.equal(calls.filter(([name]) => name === 'close').length, 1);
});

test('WebP is preferred and JPEG fallback fills transparency', async () => {
  const preferred = await makePreparedPhoto();
  assert.equal(preferred.prepared.contentType, 'image/webp');
  assert.equal(isPreparedProfilePhoto(preferred.prepared), true);
  assert.equal(preferred.recorder.canvases[0].operations.some(([name]) => name === 'fillRect'), false);

  const fallback = await makePreparedPhoto({
    options: {
      encodeCanvas: async (_canvas, type) => type === 'image/webp'
        ? sizedBlob(1000, 'image/png')
        : sizedBlob(PROFILE_PHOTO_MAX_OUTPUT_BYTES, 'image/jpeg'),
    },
  });
  assert.equal(fallback.prepared.contentType, 'image/jpeg');
  assert.ok(fallback.recorder.canvases.some(({ operations }) => (
    operations.some(([name]) => name === 'fillRect')
  )));
});

test('compression reduces quality until the avatar is at most 150 KB', async () => {
  const attempted = [];
  const { prepared } = await makePreparedPhoto({
    options: {
      encodeCanvas: async (_canvas, type, quality) => {
        attempted.push(quality);
        return sizedBlob(
          quality > 0.58 ? PROFILE_PHOTO_MAX_OUTPUT_BYTES + 1 : 96000,
          type,
        );
      },
    },
  });
  assert.deepEqual(attempted, [0.88, 0.82, 0.76, 0.68, 0.58]);
  assert.ok(prepared.blob.size <= PROFILE_PHOTO_MAX_OUTPUT_BYTES);
});

test('invalid, empty, oversized, and undecodable HEIC inputs are actionable', async () => {
  assert.throws(
    () => validateProfilePhotoInput(fakeFile({ name: 'animation.gif', type: 'image/gif' })),
    /JPG, PNG, WebP, HEIC, or HEIF/,
  );
  assert.throws(() => validateProfilePhotoInput(fakeFile({ size: 0 })), /empty/);
  assert.throws(
    () => validateProfilePhotoInput(fakeFile({ size: PROFILE_PHOTO_MAX_INPUT_BYTES + 1 })),
    /smaller than 5 MB/,
  );
  await assert.rejects(
    prepareProfilePhoto(fakeFile({ name: 'portrait.heic', type: 'image/heic' }), {
      decodeImage: async () => { throw new Error('unavailable'); },
    }),
    /Export the photo as JPG or PNG/,
  );
});

test('new paths are immutable, strict, owned, and canonicalized to this project', () => {
  const userId = '10000000-0000-4000-8000-000000000001';
  const path = createProfilePhotoStoragePath(
    userId,
    'webp',
    1720000000000,
    '0123456789abcdef0123456789abcdef',
  );
  assert.equal(
    path,
    `${userId}/avatar-1720000000000-0123456789abcdef0123456789abcdef.webp`,
  );
  assert.equal(isNewProfilePhotoPath(path, userId), true);
  assert.equal(isNewProfilePhotoPath(`${userId}/avatar-1720000000000.webp`, userId), false);
  assert.equal(ownedProfilePhotoPathFromUrl(path, userId), path);
  assert.equal(
    canonicalProfilePhotoUrl(path, userId, 'https://project.supabase.co'),
    `https://project.supabase.co/storage/v1/object/public/profile-photos/${path}`,
  );

  const external = `https://untrusted.example/storage/v1/object/public/profile-photos/${path}?v=1`;
  assert.equal(ownedProfilePhotoPathFromUrl(external, userId), path);
  assert.equal(
    canonicalProfilePhotoUrl(external, userId, 'https://project.supabase.co'),
    `https://project.supabase.co/storage/v1/object/public/profile-photos/${path}`,
  );
  assert.equal(ownedProfilePhotoPathFromUrl(external, '20000000-0000-4000-8000-000000000002'), '');
});

test('intentional text edits conflict instead of overwriting a newer profile', async () => {
  let attempts = 0;
  await assert.rejects(
    commitProfileUpdateWithCompareAndSwap({
      expectedUpdatedAt: 'version-a',
      tryCommit: async () => {
        attempts += 1;
        return null;
      },
      readCurrentProfile: async () => ({
        name: 'Newer Name', email: 'newer@example.com', avatarUrl: 'avatar-b', updatedAt: 'version-b',
      }),
      isCommitted: () => false,
    }),
    (error) => error.profileConflict === true,
  );
  assert.equal(attempts, 1);
});

test('avatar-only retry preserves intervening name and email edits', async () => {
  let canonical = {
    name: 'Original', email: 'original@example.com', avatarUrl: 'avatar-a', updatedAt: 'version-a',
  };
  let attempts = 0;
  const saved = await commitProfileUpdateWithCompareAndSwap({
    expectedUpdatedAt: 'version-a',
    avatarOnly: true,
    tryCommit: async (expectedVersion) => {
      attempts += 1;
      if (attempts === 1) {
        canonical = {
          name: 'Newer Name', email: 'newer@example.com', avatarUrl: 'avatar-b', updatedAt: 'version-b',
        };
        return null;
      }
      assert.equal(expectedVersion, 'version-b');
      canonical = { ...canonical, avatarUrl: 'avatar-c', updatedAt: 'version-c' };
      return canonical;
    },
    readCurrentProfile: async () => canonical,
    isCommitted: (profile) => profile?.avatarUrl === 'avatar-c',
  });
  assert.equal(saved.avatarUrl, 'avatar-c');
  assert.equal(saved.name, 'Newer Name');
  assert.equal(saved.email, 'newer@example.com');
});

test('a committed update survives a lost response after canonical reread', async () => {
  const saved = await commitProfileUpdateWithCompareAndSwap({
    expectedUpdatedAt: 'version-a',
    tryCommit: async () => { throw new Error('response lost'); },
    readCurrentProfile: async () => ({ avatarUrl: 'avatar-b', updatedAt: 'version-b' }),
    isCommitted: (profile) => profile?.avatarUrl === 'avatar-b',
  });
  assert.equal(saved.avatarUrl, 'avatar-b');
});

test('replacement drains durable cleanup after both success and profile failure', async () => {
  const { prepared } = await makePreparedPhoto();
  const successEvents = [];
  const success = await replaceProfilePhoto({
    preparedPhoto: prepared,
    profile: { avatarOnly: true },
    uploadPhoto: async () => {
      successEvents.push('upload');
      return { avatarUrl: 'avatar-b', storagePath: 'user/avatar-b.webp' };
    },
    saveProfile: async (profile) => {
      successEvents.push('save');
      return profile;
    },
    cleanupQueuedPhotos: async () => successEvents.push('cleanup'),
  });
  assert.deepEqual(successEvents, ['upload', 'save', 'cleanup']);
  assert.equal(success.savedProfile.avatarUrl, 'avatar-b');

  const failedEvents = [];
  await assert.rejects(replaceProfilePhoto({
    preparedPhoto: prepared,
    profile: {},
    uploadPhoto: async () => {
      failedEvents.push('upload');
      return { avatarUrl: 'avatar-c', storagePath: 'user/avatar-c.webp' };
    },
    saveProfile: async () => {
      failedEvents.push('save');
      throw new Error('profile conflict');
    },
    abandonUploadedPhoto: async () => failedEvents.push('abandon'),
    cleanupQueuedPhotos: async () => failedEvents.push('cleanup'),
  }), /profile conflict/);
  assert.deepEqual(failedEvents, ['upload', 'save', 'abandon', 'cleanup']);
});

test('client source negotiates the legacy schema and uses registered atomic photo commits', () => {
  const apiSource = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
  const profileStoreSource = readFileSync(new URL('./profile-store.mjs', import.meta.url), 'utf8');
  const profileSource = readFileSync(new URL('./profile.js', import.meta.url), 'utf8');
  const profileHtml = readFileSync(new URL('../../profile.html', import.meta.url), 'utf8');
  assert.match(apiSource, /PROFILE_COLUMNS/);
  assert.match(apiSource, /LEGACY_PROFILE_COLUMNS/);
  assert.match(apiSource, /isMissingProfilePhotoSchemaError/);
  assert.match(profileStoreSource, /profile_photo_available: false/);
  assert.match(apiSource, /ensureProfileRecord/);
  assert.match(apiSource, /\.update\(patch\)/);
  assert.match(apiSource, /register_profile_photo_upload/);
  assert.ok(
    apiSource.indexOf("register_profile_photo_upload")
      < apiSource.indexOf(".upload(storagePath, preparedPhoto.blob"),
  );
  assert.match(apiSource, /commit_profile_photo_upload/);
  assert.match(apiSource, /abandon_profile_photo_upload/);
  assert.match(apiSource, /\.upload\(storagePath, preparedPhoto\.blob/);
  assert.match(apiSource, /contentType: preparedPhoto\.contentType/);
  assert.match(apiSource, /upsert: false/);
  assert.match(apiSource, /target_expected_updated_at: expectedUpdatedAt/);
  assert.match(apiSource, /avatarOnly/);
  assert.match(apiSource, /return \{ userId: user\.id \|\| '', name, email, avatarUrl: ''/);
  assert.match(profileHtml, /id="profilePhotoInput"[\s\S]*?disabled/);
  assert.match(profileSource, /prepareProfilePhoto\(file\)/);
  assert.match(profileSource, /isBusy \|\| !profilePhotoAvailable/);
  assert.match(profileSource, /textChanged/);
  assert.doesNotMatch(profileSource, /uploadProfilePhoto\(selectedPhotoFile\)/);
});

test('database hardening uses an immutable lifecycle registry and never SQL-deletes Storage objects', () => {
  const migration = readFileSync(
    new URL('../../supabase/migrations/20260722152851_harden_profile_photo_thumbnails.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /153600/);
  assert.match(migration, /array\['image\/jpeg', 'image\/webp'\]/);
  assert.match(migration, /private\.profile_photo_objects/);
  assert.match(migration, /private\.profile_photo_path_tombstones/);
  assert.match(migration, /pending_upload.*canonical.*cleanup.*retired/s);
  assert.match(migration, /storage_path text not null unique/);
  assert.match(migration, /profile_photo_objects_one_canonical_idx/);
  assert.match(migration, /register_profile_photo_upload/);
  assert.match(migration, /commit_profile_photo_upload/);
  assert.match(migration, /abandon_profile_photo_upload/);
  assert.match(migration, /guard_profile_photo_storage_insert/);
  assert.match(migration, /guard_profile_photo_storage_update/);
  assert.match(migration, /guard_profile_photo_storage_delete/);
  assert.match(migration, /Canonical profile photos cannot be deleted/);
  assert.match(migration, /Pending account erasure blocks personal asset deletes/);
  assert.match(migration, /revoke insert, update on public\.profiles from authenticated/);
  assert.match(migration, /grant update \(name, email, challenge_start_date, time_zone\)/);
  assert.match(migration, /avatar-\[0-9\]\{13\}-\[a-f0-9\]\{32\}/);
  assert.doesNotMatch(migration, /delete\s+from\s+storage\.objects/i);
});
