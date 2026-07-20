import type { ClaimedDelivery } from "./integration_delivery.ts";

export type OutboundDeliveryResolution = {
  eligible: boolean;
  reason: string;
  presentationMode: "anonymous" | "named";
  subjectName: string | null;
  crewName: string | null;
  includeSafeLink: boolean;
};

const reasonPattern = /^[a-z][a-z0-9_]{0,63}$/;

function record(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function nullableText(value: unknown, label: string, maximum = 120) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
    .replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requiredText(value: unknown, label: string, maximum = 120) {
  const normalized = nullableText(value, label, maximum);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (
    typeof value !== "number" || !Number.isInteger(value) ||
    value < minimum || value > maximum
  ) throw new Error(`${label} is invalid.`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (
    actual.length !== allowed.length ||
    actual.some((key, index) => key !== allowed[index])
  ) throw new Error("Outbound event payload has unsupported fields.");
}

/**
 * Provider-neutral escaping for values that may be controlled by a user.
 * Transport adapters also turn off provider mention expansion as defense in
 * depth. Known Dominion links are appended separately after this escaping.
 */
export function escapeProviderMarkup(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/@/g, "＠")
    .replace(/#/g, "＃")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/&/g, "＆")
    .replace(/([*_~`|\[\]])/g, "\\$1");
}

export function parseOutboundDeliveryResolution(
  value: unknown,
): OutboundDeliveryResolution {
  const source = record(value, "Outbound delivery resolution");
  if (typeof source.eligible !== "boolean") {
    throw new Error("Outbound delivery eligibility is unavailable.");
  }
  if (typeof source.reason !== "string" || !reasonPattern.test(source.reason)) {
    throw new Error("Outbound delivery reason is invalid.");
  }
  if (
    source.presentationMode !== "anonymous" &&
    source.presentationMode !== "named"
  ) throw new Error("Outbound presentation mode is invalid.");
  if (typeof source.includeSafeLink !== "boolean") {
    throw new Error("Outbound safe-link preference is invalid.");
  }
  return {
    eligible: source.eligible,
    reason: source.reason,
    presentationMode: source.presentationMode,
    subjectName: nullableText(source.subjectName, "Subject name"),
    crewName: nullableText(source.crewName, "Group name"),
    includeSafeLink: source.includeSafeLink,
  };
}

export function safeCommunityUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const local = parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    if (
      parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")
    ) {
      return null;
    }
    if (parsed.username || parsed.password) return null;
    return new URL("/community.html", parsed.origin).toString();
  } catch {
    return null;
  }
}

function subject(resolution: OutboundDeliveryResolution) {
  return resolution.presentationMode === "named" && resolution.subjectName
    ? resolution.subjectName
    : "A group member";
}

function eventText(
  delivery: Pick<ClaimedDelivery, "event_type" | "payload">,
  resolution: OutboundDeliveryResolution,
) {
  const payload = record(delivery.payload, "Outbound event payload");
  const member = subject(resolution);

  if (delivery.event_type === "check_in") {
    exactKeys(payload, ["challengeDay", "status", "completedCount"]);
    const challengeDay = integer(payload.challengeDay, "Challenge day", 1, 77);
    const completedCount = integer(
      payload.completedCount,
      "Completed standard count",
      0,
      7,
    );
    if (payload.status !== "complete" && payload.status !== "partial") {
      throw new Error("Check-In status is invalid.");
    }
    const status = payload.status === "complete" ? "complete" : "partial";
    return `${member} submitted a ${status} Daily Check-In for challenge day ${challengeDay} (${completedCount} of 7 standards).`;
  }

  if (delivery.event_type === "streak_milestone") {
    exactKeys(payload, ["streakType", "milestone"]);
    if (
      payload.streakType !== "app" && payload.streakType !== "full_standard"
    ) throw new Error("Streak type is invalid.");
    const milestone = integer(payload.milestone, "Streak milestone", 1, 10000);
    const streak = payload.streakType === "app"
      ? "app streak"
      : "full-standard streak";
    return `${member} reached a ${milestone}-day ${streak} milestone.`;
  }

  if (delivery.event_type === "badge_reward") {
    exactKeys(payload, ["rewardKind", "rewardName"]);
    if (payload.rewardKind !== "badge" && payload.rewardKind !== "challenge") {
      throw new Error("Reward kind is invalid.");
    }
    const name = requiredText(payload.rewardName, "Reward name", 100);
    const kind = payload.rewardKind === "badge" ? "badge" : "reward";
    return `${member} unlocked the ${kind} “${name}”.`;
  }

  if (delivery.event_type === "membership") {
    exactKeys(payload, []);
    return `${member} joined the private group.`;
  }

  if (delivery.event_type === "leaderboard_recap") {
    exactKeys(payload, [
      "periodLabel",
      "memberCount",
      "checkInCount",
      "completedStandards",
    ]);
    const period = requiredText(payload.periodLabel, "Recap period", 40);
    const memberCount = integer(payload.memberCount, "Member count", 0, 100000);
    const checkInCount = integer(
      payload.checkInCount,
      "Check-In count",
      0,
      1000000,
    );
    const completedStandards = integer(
      payload.completedStandards,
      "Completed standards",
      0,
      7000000,
    );
    return `${period} recap: ${memberCount} group members submitted ${checkInCount} Check-Ins and completed ${completedStandards} standards.`;
  }

  if (delivery.event_type === "synthetic.delivery") {
    exactKeys(payload, ["text"]);
    requiredText(payload.text, "Synthetic test text", 2000);
    return "Integration delivery check. No member activity is included.";
  }

  throw new Error("Unsupported outbound event type.");
}

export function renderOutboundEvent(
  delivery: Pick<ClaimedDelivery, "event_type" | "payload">,
  resolution: OutboundDeliveryResolution,
  communityUrl: string | null,
) {
  if (!resolution.eligible) {
    throw new Error("An ineligible outbound delivery cannot be rendered.");
  }
  const group = resolution.crewName || "Dominion private group";
  const text = `77 Dominion · ${group}\n${eventText(delivery, resolution)}`;
  const testPrefix = delivery.event_type === "synthetic.delivery"
    ? "[TEST] "
    : "";
  return {
    text: `${testPrefix}${escapeProviderMarkup(text)}${
      resolution.includeSafeLink && communityUrl
        ? `\nOpen Dominion: ${communityUrl}`
        : ""
    }`,
  };
}
