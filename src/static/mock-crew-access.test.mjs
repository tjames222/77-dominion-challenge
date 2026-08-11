import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  mockCrewMembership,
  mockCrewsForUser,
  requireMockCrewRole,
} from './mock-crew-access.mjs';

const crews = [
  { id: 'crew-a', name: 'A Private Crew', createdBy: 'auth-a', role: 'owner' },
  { id: 'crew-b', name: 'B Private Crew', createdBy: 'auth-b', role: 'owner' },
];
const members = {
  'crew-a': [
    { crewId: 'crew-a', userId: 'auth-a', role: 'owner', joinedAt: '2026-08-01' },
    { crewId: 'crew-a', userId: 'auth-b', role: 'member', joinedAt: '2026-08-02' },
  ],
  'crew-b': [
    { crewId: 'crew-b', userId: 'auth-b', role: 'owner', joinedAt: '2026-08-03' },
  ],
};

describe('mock crew account authorization', () => {
  test('filters the shared crew universe through the current UUID membership', () => {
    assert.deepEqual(mockCrewsForUser([crews[0]], members, 'auth-a'), [{
      ...crews[0],
      role: 'owner',
      joinedAt: '2026-08-01',
    }]);
    assert.deepEqual(mockCrewsForUser([crews[1]], members, 'auth-a'), []);
  });

  test('derives role from the member row rather than the global crew record', () => {
    assert.equal(mockCrewMembership(members, 'crew-a', 'auth-b')?.role, 'member');
    assert.throws(() => requireMockCrewRole({
      crews,
      members,
      crewId: 'crew-a',
      userId: 'auth-b',
      allowedRoles: ['owner', 'admin'],
    }), /does not allow/);
    assert.equal(requireMockCrewRole({
      crews,
      members,
      crewId: 'crew-a',
      userId: 'auth-a',
      allowedRoles: ['owner', 'admin'],
    }).crew.role, 'owner');
  });

  test('fails closed when one account has multiple active memberships', () => {
    assert.throws(
      () => mockCrewsForUser(crews, members, 'auth-b'),
      /more than one active crew/,
    );
  });
});
