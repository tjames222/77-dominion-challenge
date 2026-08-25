function withoutCurrentUserAvatar(record, identityKey, currentUserId) {
  if (!currentUserId || record?.[identityKey] !== currentUserId) return { ...record };
  const { avatarUrl: _avatarUrl, ...persistedRecord } = record;
  return persistedRecord;
}

export function prepareMockCrewMembersForStorage(membersByCrew = {}, currentUserId = '') {
  return Object.fromEntries(
    Object.entries(membersByCrew).map(([crewId, members]) => [
      crewId,
      (Array.isArray(members) ? members : []).map((member) => (
        withoutCurrentUserAvatar(member, 'userId', currentUserId)
      )),
    ]),
  );
}

export function prepareMockCommunityPostsForStorage(posts = [], currentUserId = '') {
  return (Array.isArray(posts) ? posts : []).map((post) => ({
    ...withoutCurrentUserAvatar(post, 'authorId', currentUserId),
    // Binary preview media lives in IndexedDB so ordinary photos do not exhaust localStorage.
    imageUrl: post.imagePath ? '' : post.imageUrl || '',
    reactions: (Array.isArray(post.reactions) ? post.reactions : []).map((reaction) => (
      withoutCurrentUserAvatar(reaction, 'userId', currentUserId)
    )),
    comments: (Array.isArray(post.comments) ? post.comments : []).map((comment) => (
      withoutCurrentUserAvatar(comment, 'userId', currentUserId)
    )),
  }));
}
