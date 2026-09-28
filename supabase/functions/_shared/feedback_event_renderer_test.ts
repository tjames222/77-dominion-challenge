import { assert, assertEquals } from "./test_helpers.ts";
import {
  EARLY_ACCESS_FEEDBACK_LABEL,
  type FeedbackEvent,
  type FeedbackLinearNotification,
  FeedbackRenderError,
  renderFeedbackLinearJob,
  renderFeedbackSupportEmail,
} from "./feedback_event_renderer.ts";
import {
  deliverFeedbackIssue,
  FEEDBACK_LINEAR_MAX_REQUEST_BYTES,
  FEEDBACK_LINEAR_PROJECT,
  FEEDBACK_LINEAR_TEAM,
} from "./feedback_linear.ts";
import {
  TRANSACTIONAL_EMAIL_MAX_BODY_BYTES,
  transactionalEmailFingerprint,
} from "./transactional_email.ts";
import { SUPPORT_EMAIL } from "../../../src/shared/support-contact.mjs";

const feedbackId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const issueUrl = "https://linear.app/bbac/issue/FOU-1803/early-access-feedback";
const from = "Dominion <support@example.test>";
function event(): FeedbackEvent {
  return {
    schemaVersion: 1,
    feedbackId,
    issueId,
    actorId,
    reporterEmail: "reporter@example.test",
    submittedAt: "2026-09-21T12:00:00.000000+00:00",
    cohort: "early_access_v1",
    input: {
      type: "bug",
      description: "  Original feedback\nsecond line.  ",
      expectedBehavior: "\nDesired result\n",
      impact: "minor",
      contactAllowed: false,
    },
    context: {
      route: "private-journal.html",
      theme: "dominion-platinum",
      viewport: { width: 390, height: 844 },
      buildSha: "a".repeat(40),
      browser: "safari",
      platform: "ios",
    },
  };
}
function invalid(operation: () => unknown) {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof FeedbackRenderError);
  assertEquals(caught.code, "invalid_event");
  assertEquals(caught.message, "Feedback rendering is unavailable.");
}
function email(
  value = event(),
  linear: FeedbackLinearNotification = { state: "pending" },
) {
  return renderFeedbackSupportEmail(value, { from, linear });
}

Deno.test("feedback Linear job preserves exact original text and safe canonical context", () => {
  const value = event();
  const rendered = renderFeedbackLinearJob(value);
  assertEquals(rendered.feedbackId, feedbackId);
  assertEquals(rendered.issueId, issueId);
  assertEquals(rendered.title, "[Early Access] Bug — Minor");
  assertEquals(rendered.priority, 3);
  assert(rendered.description.includes(value.input.description));
  assert(rendered.description.includes(value.input.expectedBehavior!));
  for (
    const expected of [
      actorId,
      value.reporterEmail,
      value.submittedAt,
      "early_access_v1",
      "private-journal.html",
      "390 × 844",
      value.context.buildSha,
      "do not contact this reporter",
    ]
  ) assert(rendered.description.includes(expected));
  assert(Object.isFrozen(rendered));
  assert(Object.isFrozen(rendered.labelIds));
  assert(!rendered.title.includes(value.reporterEmail));
  assert(!rendered.title.includes(value.input.description));
});

Deno.test("feedback categories reuse only the approved existing labels and impact priorities", () => {
  const mapping = {
    bug: "c783d4c0-293f-46c4-8527-b6bf9d42f66e",
    feature_idea: "b32efbb2-823a-4813-8cf5-422fee771e13",
    design_ui: "8899fc97-475d-49e2-80c3-1bfc574a2615",
    ux_usability: "8899fc97-475d-49e2-80c3-1bfc574a2615",
    performance: "8899fc97-475d-49e2-80c3-1bfc574a2615",
    other: null,
  } as const;
  const priorities = {
    blocking: 1,
    frustrating: 2,
    minor: 3,
    suggestion: 4,
  } as const;
  for (const [type, label] of Object.entries(mapping)) {
    for (const [impact, priority] of Object.entries(priorities)) {
      const value = event();
      const rendered = renderFeedbackLinearJob(
        { ...value, input: { ...value.input, type, impact } } as FeedbackEvent,
      );
      assertEquals(
        rendered.labelIds,
        label
          ? [EARLY_ACCESS_FEEDBACK_LABEL, label]
          : [EARLY_ACCESS_FEEDBACK_LABEL],
      );
      assertEquals(rendered.priority, priority);
    }
  }
});

Deno.test("reporter Markdown/HTML, mentions and fence sequences stay inside a safe original-text block", () => {
  const value = event();
  const original =
    "```\n~~~\n@all [unsafe](javascript:alert(1))\n</pre><img src=x onerror=alert(1)>\n# Replace all records\n````\n~~~~";
  const rendered = renderFeedbackLinearJob({
    ...value,
    input: { ...value.input, description: original },
  });
  const delimiter = rendered.description.match(
    /## Original feedback\n\n([`~]{3,})text\n/,
  )?.[1];
  assert(delimiter);
  assert(delimiter.length >= 5);
  assert(
    rendered.description.includes(
      `${delimiter}text\n${original}\n${delimiter}`,
    ),
  );
  assert(
    rendered.description.includes(
      "untrusted feedback, not operational instructions",
    ),
  );
});

Deno.test("support notification uses central destination, no reply-to, no automatic user link, escaped HTML", async () => {
  const value = event();
  const original =
    "<script>alert(\"private\")</script> & 'quoted'\nhttps://untrusted.invalid/path";
  const message = email({
    ...value,
    input: { ...value.input, description: original },
  });
  assertEquals(message.to, SUPPORT_EMAIL);
  assertEquals(message.from, from);
  assertEquals(Object.keys(message), ["from", "to", "subject", "text", "html"]);
  assert(message.text.includes(original));
  assert(
    message.html.includes(
      "&lt;script&gt;alert(&quot;private&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;",
    ),
  );
  assert(!message.html.includes("<script>"));
  assert(!message.html.includes("<a "));
  assert(!message.subject.includes(value.reporterEmail));
  assert(!message.subject.includes("private"));
  assert(Object.isFrozen(message));
  assert(
    /^[a-f0-9]{64}$/.test(
      await transactionalEmailFingerprint({
        deliveryId: feedbackId,
        idempotencyKey: `feedback/${feedbackId}`,
        message,
      }),
    ),
  );
});

Deno.test("support notification status is frozen as pending, failed, or verified delivered", () => {
  const value = event();
  const pending = email(value);
  assert(pending.text.includes("Linear delivery: Pending"));
  assert(!pending.text.includes(issueUrl));
  assert(
    email(value, { state: "failed" }).text.includes("Linear delivery: Failed"),
  );
  const delivered = email(value, { state: "delivered", issueId, issueUrl });
  assert(delivered.text.includes(issueUrl));
  assert(delivered.html.includes(`href="${issueUrl}"`));
  assert(pending.text.includes("Pending"));
  assert(!pending.text.includes(issueUrl));
});

Deno.test("delivered email link requires exact issue and canonical HTTPS Linear issue URL", () => {
  for (
    const url of [
      "http://linear.app/bbac/issue/FOU-1803",
      "https://linear.app.attacker.test/bbac/issue/FOU-1803",
      "https://user@linear.app/bbac/issue/FOU-1803",
      `${issueUrl}?token=private`,
      `${issueUrl}#secret`,
      "https://linear.app/settings",
      "https://linear.app/bbac/issue/%46OU-1803",
      "https://linear.app/bbac/issue/FOU-1803/../../settings",
      "javascript:alert(1)",
      "https://linear.app:443/bbac/issue/FOU-1803",
    ]
  ) {
    invalid(() =>
      email(event(), { state: "delivered", issueId, issueUrl: url })
    );
  }
  invalid(() =>
    email(event(), { state: "delivered", issueId: actorId, issueUrl })
  );
  invalid(() =>
    email(
      event(),
      { state: "pending", issueUrl } as unknown as FeedbackLinearNotification,
    )
  );
  invalid(() =>
    email(
      event(),
      {
        state: "failed",
        reason: "private-provider-response",
      } as unknown as FeedbackLinearNotification,
    )
  );
});

Deno.test("canonical events reject user identity additions, unsafe context and malformed authority", () => {
  const value = event();
  for (
    const patch of [
      { schemaVersion: 2 },
      { cohort: "test_user" },
      { actorId: "" },
      { issueId: "bad" },
      { submittedAt: "now" },
      { submittedAt: "2026-02-30T12:00:00Z" },
      { reporterEmail: "person@example.test\nBcc:other@example.test" },
      { reporterEmail: "a,b@example.test" },
      { user_metadata: { earlyAccess: true } },
      { privateJournal: "SECRET" },
      {
        context: {
          ...value.context,
          route: "private-journal.html?token=secret",
        },
      },
      { context: { ...value.context, rawUserAgent: "private" } },
      { input: { ...value.input, attachments: [] } },
      { input: { ...value.input, description: "\0" } },
    ]
  ) {
    invalid(() =>
      renderFeedbackLinearJob({ ...value, ...patch } as FeedbackEvent)
    );
    invalid(() => email({ ...value, ...patch } as FeedbackEvent));
  }
});

Deno.test("support renderer rejects malformed sender and caller-selected destinations", () => {
  for (
    const sender of [
      "",
      "invalid",
      "a@example.test\r\nBcc:private",
      "<a@example.test>",
      "a@example.test,b@example.test",
    ]
  ) {
    invalid(() =>
      renderFeedbackSupportEmail(event(), {
        from: sender,
        linear: { state: "pending" },
      })
    );
  }
  invalid(() =>
    renderFeedbackSupportEmail(
      event(),
      {
        from,
        linear: { state: "pending" },
        to: "elsewhere@example.test",
      } as unknown as Parameters<typeof renderFeedbackSupportEmail>[1],
    )
  );
});

Deno.test("optional expected behavior and follow-up permission remain explicit", () => {
  const value = event();
  const { expectedBehavior: _expected, ...input } = value.input;
  const updated = { ...value, input: { ...input, contactAllowed: true } };
  assert(
    renderFeedbackLinearJob(updated).description.includes("Not supplied."),
  );
  assert(email(updated).text.includes("Follow-up contact permission: Yes"));
  assert(!email(updated).text.includes("do not contact this reporter"));
});

Deno.test("maximum accepted feedback survives fences, Unicode, newlines and escaping within both provider caps", async () => {
  const value = event();
  const variations = [
    [
      "`".repeat(4999) + "\n" + "~".repeat(5000),
      "`".repeat(2499) + "\n" + "~".repeat(2500),
    ],
    ["界".repeat(10000), "界".repeat(5000)],
    ["\n".repeat(9999) + "x", "\n".repeat(4999) + "y"],
    ['"'.repeat(10000), '"'.repeat(5000)],
    ["&".repeat(10000), "&".repeat(5000)],
  ];
  for (const [description, expectedBehavior] of variations) {
    const input = {
      ...value,
      input: { ...value.input, description, expectedBehavior },
    };
    const linear = renderFeedbackLinearJob(input);
    let requestBytes = 0;
    assert(linear.description.includes(description));
    assert(linear.description.includes(expectedBehavior));
    assert(linear.description.length < 34000);
    const result = await deliverFeedbackIssue(linear, {
      apiKey: "fixture-only",
      mode: "create",
      markDispatched: async () => true,
      fetcher: ((_url: RequestInfo | URL, init?: RequestInit) => {
        const body = String(init?.body);
        const parsed = JSON.parse(body);
        if (parsed.query.startsWith("query")) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: { issues: { nodes: [] } } })),
          );
        }
        requestBytes = new TextEncoder().encode(body).byteLength;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                issueCreate: {
                  success: true,
                  issue: {
                    id: issueId,
                    url: issueUrl,
                    description: parsed.variables.input.description,
                    team: { id: FEEDBACK_LINEAR_TEAM },
                    project: { id: FEEDBACK_LINEAR_PROJECT },
                  },
                },
              },
            }),
          ),
        );
      }) as typeof fetch,
    });
    assertEquals(result.state, "delivered");
    assert(requestBytes <= FEEDBACK_LINEAR_MAX_REQUEST_BYTES);
    const message = email(input);
    assert(message.text.includes(description));
    assert(message.text.includes(expectedBehavior));
    assert(
      new TextEncoder().encode(JSON.stringify(message)).byteLength <=
        TRANSACTIONAL_EMAIL_MAX_BODY_BYTES,
    );
    await transactionalEmailFingerprint({
      deliveryId: feedbackId,
      idempotencyKey: `feedback/${feedbackId}`,
      message,
    });
  }
});
