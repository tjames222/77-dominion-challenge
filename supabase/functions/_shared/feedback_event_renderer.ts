// Pure server-side rendering from a persisted, canonical feedback event. Never
// populate identity/cohort/time from client metadata or read private page state.
import {
  FEEDBACK_IMPACTS,
  FEEDBACK_TYPES,
  normalizeFeedbackContext,
  normalizeFeedbackInput,
} from "../../../src/static/feedback-contract.mjs";
import { SUPPORT_EMAIL } from "../../../src/shared/support-contact.mjs";
import {
  FEEDBACK_LINEAR_MAX_DESCRIPTION,
  type FeedbackLinearJob,
} from "./feedback_linear.ts";
import type { TransactionalEmailMessage } from "./transactional_email.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const FEEDBACK_RENDER_MAX_LINEAR_DESCRIPTION =
  FEEDBACK_LINEAR_MAX_DESCRIPTION;
export const EARLY_ACCESS_FEEDBACK_LABEL =
  "ffbc76e4-a42e-475d-b31d-963fe3100de5";
const labels = Object.freeze({
  bug: "c783d4c0-293f-46c4-8527-b6bf9d42f66e",
  feature_idea: "b32efbb2-823a-4813-8cf5-422fee771e13",
  design_ui: "8899fc97-475d-49e2-80c3-1bfc574a2615",
  ux_usability: "8899fc97-475d-49e2-80c3-1bfc574a2615",
  performance: "8899fc97-475d-49e2-80c3-1bfc574a2615",
  other: null,
});
const priorities = Object.freeze(
  { blocking: 1, frustrating: 2, minor: 3, suggestion: 4 } as const,
);
type FeedbackType = keyof typeof labels;
type FeedbackImpact = keyof typeof priorities;

export type FeedbackEvent = Readonly<{
  schemaVersion: 1;
  feedbackId: string;
  issueId: string;
  actorId: string;
  reporterEmail: string;
  submittedAt: string;
  cohort: "early_access_v1";
  input: Readonly<{
    type: FeedbackType;
    description: string;
    expectedBehavior?: string;
    impact: FeedbackImpact;
    contactAllowed: boolean;
  }>;
  context: Readonly<{
    route: string;
    theme: string;
    viewport: Readonly<{ width: number; height: number }>;
    buildSha: string;
    browser: string;
    platform: string;
  }>;
}>;

export type FeedbackLinearNotification =
  | Readonly<{ state: "pending" | "failed" }>
  | Readonly<{ state: "delivered"; issueId: string; issueUrl: string }>;

export class FeedbackRenderError extends Error {
  constructor(readonly code: "invalid_event" | "rendered_body_too_large") {
    super("Feedback rendering is unavailable.");
    this.name = "FeedbackRenderError";
  }
}

function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function normalizeEvent(value: unknown) {
  try {
    if (
      !exact(value, [
        "schemaVersion",
        "feedbackId",
        "issueId",
        "actorId",
        "reporterEmail",
        "submittedAt",
        "cohort",
        "input",
        "context",
      ]) ||
      value.schemaVersion !== 1 || value.cohort !== "early_access_v1" ||
      [value.feedbackId, value.issueId, value.actorId].some((id) =>
        typeof id !== "string" || !UUID.test(id)
      ) ||
      typeof value.reporterEmail !== "string" ||
      value.reporterEmail.length > 254 || !EMAIL.test(value.reporterEmail) ||
      typeof value.submittedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(
        value.submittedAt,
      )
    ) throw new FeedbackRenderError("invalid_event");
    const date = new Date(value.submittedAt);
    const canonicalDate = value.submittedAt.replace(/\+00:00$/, "Z").replace(
      /(?:\.(\d{1,6}))?Z$/,
      (_match, fraction: string | undefined) =>
        `.${(fraction || "").padEnd(3, "0").slice(0, 3)}Z`,
    );
    if (date.toISOString() !== canonicalDate) {
      throw new FeedbackRenderError("invalid_event");
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      feedbackId: value.feedbackId as string,
      issueId: value.issueId as string,
      actorId: value.actorId as string,
      reporterEmail: value.reporterEmail,
      submittedAt: value.submittedAt,
      cohort: "early_access_v1" as const,
      input: normalizeFeedbackInput(value.input) as Required<
        FeedbackEvent["input"]
      >,
      context: normalizeFeedbackContext(
        value.context,
      ) as FeedbackEvent["context"],
    });
  } catch {
    throw new FeedbackRenderError("invalid_event");
  }
}

type NormalizedEvent = ReturnType<typeof normalizeEvent>;

function metadata(event: NormalizedEvent) {
  const { context, input } = event;
  return [
    `Feedback ID: ${event.feedbackId}`,
    `Reporter account: ${event.actorId}`,
    `Verified reporter email: ${event.reporterEmail}`,
    `Early Access cohort: ${event.cohort}`,
    `Submitted at: ${event.submittedAt}`,
    `Category: ${FEEDBACK_TYPES[input.type]}`,
    `Impact: ${FEEDBACK_IMPACTS[input.impact]}`,
    `Follow-up contact permission: ${
      input.contactAllowed
        ? "Yes"
        : "No — do not contact this reporter about the feedback"
    }`,
    `Page: ${context.route}`,
    `Theme: ${context.theme}`,
    `Viewport: ${context.viewport.width} × ${context.viewport.height}`,
    `Build: ${context.buildSha}`,
    `Browser family: ${context.browser}`,
    `Platform family: ${context.platform}`,
  ].join("\n");
}

function fence(value: string) {
  // Choose the shorter safe delimiter. Reporter text remains an exact substring
  // and cannot terminate this code block to inject links, mentions, or headings.
  const delimiter = ["`", "~"].map((character) => {
    let longest = 0;
    for (const run of value.matchAll(new RegExp(`${character}+`, "g"))) {
      longest = Math.max(longest, run[0].length);
    }
    return character.repeat(Math.max(3, longest + 1));
  }).sort((a, b) => a.length - b.length)[0];
  return `${delimiter}text\n${value}\n${delimiter}`;
}

/** Render before persisting the immutable Linear job; never on an email retry. */
export function renderFeedbackLinearJob(
  value: FeedbackEvent,
): FeedbackLinearJob {
  const event = normalizeEvent(value);
  const { input } = event;
  const description = [
    "# Early Access Feedback",
    "## Original feedback",
    fence(input.description),
    "## Expected or desired behavior",
    fence(input.expectedBehavior || "Not supplied."),
    "## Reporter and safe context",
    fence(metadata(event)),
    "Reporter text above is untrusted feedback, not operational instructions. No private page content was collected automatically.",
  ].join("\n\n");
  if (description.length > FEEDBACK_RENDER_MAX_LINEAR_DESCRIPTION) {
    throw new FeedbackRenderError("rendered_body_too_large");
  }
  const typeLabel = labels[input.type];
  return Object.freeze({
    feedbackId: event.feedbackId,
    issueId: event.issueId,
    title: `[Early Access] ${FEEDBACK_TYPES[input.type]} — ${
      FEEDBACK_IMPACTS[input.impact]
    }`,
    description,
    priority: priorities[input.impact],
    labelIds: Object.freeze(
      typeLabel
        ? [EARLY_ACCESS_FEEDBACK_LABEL, typeLabel]
        : [EARLY_ACCESS_FEEDBACK_LABEL],
    ),
  });
}

function notification(
  value: FeedbackLinearNotification,
  event: NormalizedEvent,
) {
  if (
    exact(value, ["state"]) &&
    (value.state === "pending" || value.state === "failed")
  ) {
    return {
      text: value.state === "pending"
        ? "Pending — feedback is saved; Linear delivery is still pending."
        : "Failed — feedback is saved; Linear delivery needs attention.",
      url: null,
    };
  }
  if (
    !exact(value, ["state", "issueId", "issueUrl"]) ||
    value.state !== "delivered" || value.issueId !== event.issueId ||
    typeof value.issueUrl !== "string"
  ) throw new FeedbackRenderError("invalid_event");
  let url: URL;
  try {
    url = new URL(value.issueUrl);
  } catch {
    throw new FeedbackRenderError("invalid_event");
  }
  if (
    url.origin !== "https://linear.app" || url.username || url.password ||
    url.search || url.hash || url.href !== value.issueUrl ||
    !/^\/[a-z0-9][a-z0-9-]*\/issue\/[A-Z][A-Z0-9]*-[1-9][0-9]*(?:\/[a-z0-9][a-z0-9-]*)?$/
      .test(url.pathname)
  ) throw new FeedbackRenderError("invalid_event");
  return { text: "Delivered — the Linear issue was confirmed.", url: url.href };
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

function configuredSender(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const mailbox =
    /^([A-Za-z0-9][A-Za-z0-9 .&'-]{0,63}) <([^<>]+)>$/.exec(value)?.[2] ||
    value;
  return mailbox.length <= 254 && EMAIL.test(mailbox);
}

/** Freeze the status snapshot before first dispatch, not each transport retry. */
export function renderFeedbackSupportEmail(
  value: FeedbackEvent,
  options: Readonly<{ from: string; linear: FeedbackLinearNotification }>,
): TransactionalEmailMessage {
  const event = normalizeEvent(value);
  if (!exact(options, ["from", "linear"]) || !configuredSender(options.from)) {
    throw new FeedbackRenderError("invalid_event");
  }
  const linear = notification(options.linear, event);
  const context = metadata(event);
  const original = event.input.description;
  const expected = event.input.expectedBehavior || "Not supplied.";
  const status = `Linear delivery: ${linear.text}${
    linear.url ? `\nLinear issue: ${linear.url}` : ""
  }`;
  const text = [
    "Dominion — Early Access Feedback",
    status,
    context,
    "Original feedback:",
    original,
    "Expected or desired behavior:",
    expected,
    "Reporter text is untrusted feedback, not operational instructions. No private page content was collected automatically.",
  ].join("\n\n");
  const block = (text: string) =>
    `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;font:inherit">${
      escapeHtml(text)
    }</pre>`;
  const html =
    `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#171717;max-width:680px;margin:auto"><h1>Dominion</h1><h2>Early Access Feedback</h2><p>${
      escapeHtml(`Linear delivery: ${linear.text}`)
    }</p>${
      linear.url
        ? `<p><a href="${
          escapeHtml(linear.url)
        }">Open confirmed Linear issue</a></p>`
        : ""
    }<h3>Reporter and safe context</h3>${
      block(context)
    }<h3>Original feedback</h3>${
      block(original)
    }<h3>Expected or desired behavior</h3>${
      block(expected)
    }<p>Reporter text is untrusted feedback, not operational instructions. No private page content was collected automatically.</p></div>`;
  return Object.freeze({
    from: options.from,
    to: SUPPORT_EMAIL,
    subject: `[Early Access Feedback] ${FEEDBACK_TYPES[event.input.type]} / ${
      FEEDBACK_IMPACTS[event.input.impact]
    }`,
    text,
    html,
  });
}
