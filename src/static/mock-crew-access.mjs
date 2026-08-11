import { assertSingleCrew } from './crew-experience.mjs';

export function mockCrewMembership(members, crewId, userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return null;
  return (members?.[crewId] || []).find((member) => member.userId === normalizedUserId) || null;
}

export function mockCrewsForUser(crews, members, userId) {
  return assertSingleCrew((Array.isArray(crews) ? crews : []).flatMap((crew) => {
    const membership = mockCrewMembership(members, crew.id, userId);
    return membership && !crew.deletedAt
      ? [{ ...crew, role: membership.role, joinedAt: membership.joinedAt }]
      : [];
  }));
}

export function requireMockCrewRole({ crews, members, crewId, userId, allowedRoles }) {
  const crew = (Array.isArray(crews) ? crews : []).find((item) => item.id === crewId && !item.deletedAt);
  const membership = mockCrewMembership(members, crewId, userId);
  if (!crew || !membership || (allowedRoles && !allowedRoles.includes(membership.role))) {
    throw new Error('Current crew membership does not allow this action.');
  }
  return { crew: { ...crew, role: membership.role, joinedAt: membership.joinedAt }, membership };
}
