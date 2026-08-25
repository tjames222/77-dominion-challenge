import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  prepareMockCommunityPostsForStorage,
  prepareMockCrewMembersForStorage,
} from './mock-community-storage.mjs';

const currentUserId = 'preview-user';
const largeAvatarUrl = `data:image/jpeg;base64,${'a'.repeat(350_000)}`;

class QuotaStorage {
  constructor(limit) {
    this.limit = limit;
    this.values = new Map();
  }

  setItem(key, value) {
    const nextValues = new Map(this.values);
    nextValues.set(String(key), String(value));
    const size = [...nextValues].reduce((total, [entryKey, entryValue]) => (
      total + entryKey.length + entryValue.length
    ), 0);
    if (size > this.limit) {
      const error = new Error('The quota has been exceeded.');
      error.name = 'QuotaExceededError';
      throw error;
    }
    this.values = nextValues;
  }

  getItem(key) {
    return this.values.get(String(key)) ?? null;
  }
}

const crewMembers = () => ({
  'crew-one': [
    { userId: currentUserId, name: 'Current Member', avatarUrl: largeAvatarUrl },
    { userId: 'member-two', name: 'Other Member', avatarUrl: 'data:image/svg+xml,other' },
  ],
});

const communityPosts = () => [{
  id: 'post-one',
  authorId: currentUserId,
  avatarUrl: largeAvatarUrl,
  imagePath: 'preview/crew-one/photo.jpg',
  imageUrl: 'blob:preview-photo',
  reactions: [
    { userId: currentUserId, avatarUrl: largeAvatarUrl },
    { userId: 'member-two', avatarUrl: 'data:image/svg+xml,reaction' },
  ],
  comments: [
    { userId: currentUserId, avatarUrl: largeAvatarUrl, body: 'Current user comment' },
    { userId: 'member-two', avatarUrl: 'data:image/svg+xml,comment', body: 'Other comment' },
  ],
}];

describe('mock Community storage', () => {
  test('stores current crew identities without duplicating the profile photo', () => {
    const members = crewMembers();
    const storedMembers = prepareMockCrewMembersForStorage(members, currentUserId);

    assert.equal(storedMembers['crew-one'][0].avatarUrl, undefined);
    assert.equal(storedMembers['crew-one'][1].avatarUrl, 'data:image/svg+xml,other');
    assert.equal(members['crew-one'][0].avatarUrl, largeAvatarUrl);
  });

  test('compacts current-user avatars and binary media without mutating posts', () => {
    const posts = communityPosts();
    const storedPosts = prepareMockCommunityPostsForStorage(posts, currentUserId);

    assert.equal(storedPosts[0].avatarUrl, undefined);
    assert.equal(storedPosts[0].imageUrl, '');
    assert.equal(storedPosts[0].reactions[0].avatarUrl, undefined);
    assert.equal(storedPosts[0].comments[0].avatarUrl, undefined);
    assert.equal(storedPosts[0].reactions[1].avatarUrl, 'data:image/svg+xml,reaction');
    assert.equal(storedPosts[0].comments[1].avatarUrl, 'data:image/svg+xml,comment');
    assert.equal(posts[0].avatarUrl, largeAvatarUrl);
    assert.equal(posts[0].imageUrl, 'blob:preview-photo');
  });

  test('keeps private-group and post writes below quota with a large profile photo', () => {
    const userJson = JSON.stringify({
      name: 'Current Member',
      avatarUrl: largeAvatarUrl,
      authenticated: true,
    });
    const rawMembersJson = JSON.stringify(crewMembers());
    const rawPostsJson = JSON.stringify(communityPosts());
    const rawStorage = new QuotaStorage(525_000);
    rawStorage.setItem('dominion:user', userJson);

    assert.throws(
      () => rawStorage.setItem('dominion:mockCrewMembers', rawMembersJson),
      { name: 'QuotaExceededError' },
    );
    assert.throws(
      () => rawStorage.setItem('dominion:mockCommunityPosts', rawPostsJson),
      { name: 'QuotaExceededError' },
    );

    const compactStorage = new QuotaStorage(525_000);
    compactStorage.setItem('dominion:user', userJson);
    compactStorage.setItem(
      'dominion:mockCrewMembers',
      JSON.stringify(prepareMockCrewMembersForStorage(crewMembers(), currentUserId)),
    );
    compactStorage.setItem(
      'dominion:mockCommunityPosts',
      JSON.stringify(prepareMockCommunityPostsForStorage(communityPosts(), currentUserId)),
    );

    assert.equal(compactStorage.getItem('dominion:mockCrewMembers').includes(largeAvatarUrl), false);
    assert.equal(compactStorage.getItem('dominion:mockCommunityPosts').includes(largeAvatarUrl), false);
  });
});
