const DISCOUNT_TYPES = new Set(['partner_discount', 'merch_discount']);
const DETAIL_TYPES = new Set([...DISCOUNT_TYPES, 'digital_download']);

const safeKey = (value) => String(value || '').trim();
const safeText = (value) => typeof value === 'string' ? value.trim() : '';

export function safeHttpsUrl(value) {
  const raw = safeText(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function isFulfillmentReward(reward = {}) {
  return DETAIL_TYPES.has(safeKey(reward.rewardType || reward.reward_type));
}

export function normalizeRewardFulfillment(payload = {}) {
  const rewardType = safeKey(payload.rewardType || payload.reward_type);
  const availability = ['available', 'unavailable', 'expired', 'exhausted']
    .includes(payload.availability) ? payload.availability : 'unavailable';
  const status = ['locked', 'unclaimed', 'claimed', 'unavailable']
    .includes(payload.status) ? payload.status : 'unavailable';
  const code = status === 'claimed' ? safeText(payload.code) : '';
  return {
    rewardKey: safeKey(payload.rewardKey || payload.reward_key),
    rewardType,
    status,
    availability,
    partnerName: safeText(payload.partnerName || payload.partner_name),
    offerTitle: safeText(payload.offerTitle || payload.offer_title),
    description: safeText(payload.description),
    terms: safeText(payload.terms),
    expiration: safeText(payload.expiration),
    websiteUrl: safeHttpsUrl(payload.websiteUrl || payload.website_url),
    destinationUrl: safeHttpsUrl(payload.destinationUrl || payload.destination_url),
    code,
    claimedAt: payload.claimedAt || payload.claimed_at || null,
    downloadFilename: safeText(payload.downloadFilename || payload.download_filename),
    edition: safeText(payload.edition),
    format: safeText(payload.format) || (rewardType === 'digital_download' ? 'PDF' : ''),
    message: safeText(payload.message),
  };
}

export function buildFulfillmentDialogModel(reward = {}, payload = {}) {
  const fulfillment = normalizeRewardFulfillment({
    rewardKey: reward.key,
    rewardType: reward.rewardType,
    ...payload,
  });
  const owned = reward.status === 'owned';
  const locked = !owned;
  const discount = DISCOUNT_TYPES.has(reward.rewardType);
  const download = reward.rewardType === 'digital_download';
  const unavailable = owned && fulfillment.availability !== 'available';
  const gym = reward.key === 'gym_training_discount';
  let message = fulfillment.message;
  if (!message && locked) {
    message = `${reward.pointsRemaining} ${reward.pointsRemaining === 1 ? 'point' : 'points'} remaining.`;
  } else if (!message && unavailable) {
    message = 'You permanently own this reward. Its approved fulfillment is being finalized.';
  }

  return {
    ...fulfillment,
    title: reward.title || 'Reward details',
    locked,
    owned,
    unavailable,
    showProgress: locked,
    currentPoints: Number(reward.currentPoints || 0),
    pointsRequired: Number(reward.pointsRequired || 0),
    pointsRemaining: Number(reward.pointsRemaining || 0),
    encouragement: gym
      ? 'For the best practical training experience, complete challenge workouts at a properly equipped gym whenever it is safe and practical.'
      : '',
    canClaim: discount && owned && fulfillment.availability === 'available' && fulfillment.status === 'unclaimed',
    canReveal: discount && owned && fulfillment.availability === 'available'
      && fulfillment.status === 'claimed' && !fulfillment.code,
    canCopy: discount && owned && Boolean(fulfillment.code),
    canVisitWebsite: gym && fulfillment.availability === 'available' && Boolean(fulfillment.websiteUrl),
    canVisitDestination: discount && owned && fulfillment.availability === 'available'
      && fulfillment.status === 'claimed' && Boolean(fulfillment.destinationUrl),
    canDownload: download && owned && fulfillment.availability === 'available',
    actionLabel: download ? 'Download handbook' : fulfillment.status === 'claimed' ? 'Reveal code' : 'Claim discount',
    message,
  };
}
