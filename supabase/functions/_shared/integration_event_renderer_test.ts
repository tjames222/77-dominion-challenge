import { assert, assertEquals } from "./test_helpers.ts";
import {
  escapeProviderMarkup,
  parseOutboundDeliveryResolution,
  renderOutboundEvent,
  safeCommunityUrl,
} from "./integration_event_renderer.ts";

const namedResolution = {
  eligible: true,
  reason: "approved",
  presentationMode: "named" as const,
  subjectName: "Tim",
  crewName: "San Marcos Men",
  includeSafeLink: true,
};

function rejects(action: () => unknown) {
  try {
    action();
  } catch {
    return;
  }
  throw new Error("Expected action to reject.");
}

Deno.test("resolution parser validates the fail-closed worker contract", () => {
  assertEquals(parseOutboundDeliveryResolution(namedResolution), {
    ...namedResolution,
  });
  rejects(() =>
    parseOutboundDeliveryResolution({
      ...namedResolution,
      eligible: "yes",
    })
  );
  rejects(() =>
    parseOutboundDeliveryResolution({
      ...namedResolution,
      reason: "private reason: email@example.com",
    })
  );
});

Deno.test("renderer supports each strict provider-neutral event contract", () => {
  const cases = [
    {
      event_type: "check_in",
      payload: { challengeDay: 12, status: "complete", completedCount: 7 },
      expected: "complete Daily Check-In for challenge day 12",
    },
    {
      event_type: "streak_milestone",
      payload: { streakType: "full_standard", milestone: 14 },
      expected: "14-day full-standard streak milestone",
    },
    {
      event_type: "badge_reward",
      payload: { rewardKind: "badge", rewardName: "Sharing" },
      expected: "unlocked the badge “Sharing”",
    },
    {
      event_type: "membership",
      payload: {},
      expected: "joined the private group",
    },
    {
      event_type: "leaderboard_recap",
      payload: {
        periodLabel: "Weekly",
        memberCount: 8,
        checkInCount: 33,
        completedStandards: 201,
      },
      expected: "8 group members submitted 33 Check-Ins",
    },
  ];
  for (const source of cases) {
    const rendered = renderOutboundEvent(
      source,
      namedResolution,
      "https://app.example.com/community.html",
    );
    assert(rendered.text.includes("77 Dominion · San Marcos Men"));
    assert(rendered.text.includes(source.expected));
    assert(rendered.text.endsWith("https://app.example.com/community.html"));
  }
});

Deno.test("anonymous rendering never uses a resolved subject name", () => {
  const rendered = renderOutboundEvent({
    event_type: "membership",
    payload: {},
  }, {
    ...namedResolution,
    presentationMode: "anonymous",
    subjectName: "Must Not Leave Dominion",
    includeSafeLink: false,
  }, "https://app.example.com/community.html");
  assert(rendered.text.includes("A group member"));
  assert(!rendered.text.includes("Must Not Leave Dominion"));
  assert(!rendered.text.includes("https://"));
});

Deno.test("renderer neutralizes provider markup and mass mentions", () => {
  const rendered = renderOutboundEvent({
    event_type: "badge_reward",
    payload: {
      rewardKind: "challenge",
      rewardName: "*@everyone* <@123> [click](https://bad.test)",
    },
  }, {
    ...namedResolution,
    subjectName: "<!channel> _leader_",
    crewName: "#general | *crew*",
  }, null);
  assert(!rendered.text.includes("@everyone"));
  assert(!rendered.text.includes("<!channel>"));
  assert(!rendered.text.includes("*crew*"));
  assert(!rendered.text.includes("[click]"));
  assert(rendered.text.includes("＠everyone"));
});

Deno.test("strict payload schemas reject unknown and private fields", () => {
  for (
    const payload of [
      {
        challengeDay: 1,
        status: "complete",
        completedCount: 7,
        prayer: "private",
      },
      { rewardKind: "badge", rewardName: "Badge", email: "private@test" },
      { note: "private" },
    ]
  ) {
    rejects(() =>
      renderOutboundEvent(
        {
          event_type: Object.hasOwn(payload, "challengeDay")
            ? "check_in"
            : Object.hasOwn(payload, "rewardKind")
            ? "badge_reward"
            : "membership",
          payload,
        },
        namedResolution,
        null,
      )
    );
  }
  rejects(() =>
    renderOutboundEvent(
      {
        event_type: "check_in.committed",
        payload: { challengeDay: 1, status: "complete", completedCount: 7 },
      },
      namedResolution,
      null,
    )
  );
});

Deno.test("synthetic output is fixed, clearly marked, and content-free", () => {
  const rendered = renderOutboundEvent(
    {
      event_type: "synthetic.delivery",
      payload: { text: "private activity must not be copied" },
    },
    namedResolution,
    null,
  );
  assert(rendered.text.includes("[TEST]"));
  assert(!rendered.text.includes("private activity"));
});

Deno.test("community links accept configured HTTPS and local development only", () => {
  assertEquals(
    safeCommunityUrl("https://app.example.com/private?token=nope"),
    "https://app.example.com/community.html",
  );
  assertEquals(
    safeCommunityUrl("http://127.0.0.1:5173"),
    "http://127.0.0.1:5173/community.html",
  );
  assertEquals(safeCommunityUrl("http://app.example.com"), null);
  assertEquals(safeCommunityUrl("https://user:password@app.example.com"), null);
  assertEquals(safeCommunityUrl("not a url"), null);
});

Deno.test("provider markup escaping also protects standalone values", () => {
  assertEquals(
    escapeProviderMarkup("@everyone <@1> #room *bold*"),
    "＠everyone ‹＠1› ＃room \\*bold\\*",
  );
});
