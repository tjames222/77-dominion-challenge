/**
 * Server-only, dependency-injected NEW-account bootstrap. This module neither
 * authorizes an invitation nor sends mail. Never call it for an existing account.
 *
 * Before calling, a private transaction must durably reserve a random user UUID
 * for this claim/generation and canonical mailbox. Only that UUID can reconcile
 * an uncertain create; an email lookup is never evidence of ownership. The outer
 * writer must revalidate claim/generation/email/health before durable dispatch,
 * and must not regenerate recovery credentials after an unknown mail delivery.
 * Native links belong only in short-lived private mail material, never browser
 * responses, logs, metadata, or the seven-day application invitation payload.
 */
export type EarlyAccessAuthBootstrapInput = Readonly<{
  reservedUserId: string;
  canonicalEmail: string;
  redirectTo: string;
  /** Exact server-configured reset URLs, never request-supplied allowlists. */
  allowedRedirects: readonly string[];
  /** Trusted Supabase project/custom Auth origin, with no trailing slash. */
  authOrigin: string;
  nowMs: number;
}>;

export type EarlyAccessAuthBootstrapDependencies = Readonly<{
  createUser: (attributes: {
    id: string;
    email: string;
    email_confirm: false;
  }) => Promise<unknown>;
  getUserById: (userId: string) => Promise<unknown>;
  generateLink: (parameters: {
    type: "recovery";
    email: string;
    options: { redirectTo: string };
  }) => Promise<unknown>;
}>;

/** This return value is secret mail material, NOT an HTTP response DTO. */
export type ServerOnlyEarlyAccessRecoveryMail = Readonly<{
  userId: string;
  recipient: string;
  recoveryActionLink: string;
}>;

export type EarlyAccessAuthBootstrapErrorCode =
  | "configuration_invalid"
  | "account_unavailable"
  | "account_conflict"
  | "account_changed"
  | "recovery_link_unavailable"
  | "recovery_link_invalid"
  | "bootstrap_unavailable";

export class EarlyAccessAuthBootstrapError extends Error {
  readonly code: EarlyAccessAuthBootstrapErrorCode;

  constructor(code: EarlyAccessAuthBootstrapErrorCode) {
    // Deliberately retain no provider message, payload, cause, identity or link.
    super("Early-access account setup is unavailable.");
    this.code = code;
    this.name = "EarlyAccessAuthBootstrapError";
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function fail(code: EarlyAccessAuthBootstrapErrorCode): never {
  throw new EarlyAccessAuthBootstrapError(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function absent(value: unknown) {
  return value === undefined || value === null;
}

function cleanHttpsUrl(value: unknown): URL | null {
  if (
    typeof value !== "string" || value.length > 4096 ||
    value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value) ||
    value.includes("#") || /^https:\/\/[^/?#]*@/i.test(value)
  ) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
        !url.hash
      ? url
      : null;
  } catch {
    return null;
  }
}

function snapshot(input: EarlyAccessAuthBootstrapInput) {
  const {
    reservedUserId,
    canonicalEmail,
    redirectTo,
    allowedRedirects,
    authOrigin,
    nowMs,
  } = input;
  const authUrl = cleanHttpsUrl(authOrigin);
  if (
    typeof reservedUserId !== "string" || !UUID.test(reservedUserId) ||
    typeof canonicalEmail !== "string" ||
    canonicalEmail.length > 254 || !EMAIL.test(canonicalEmail) ||
    !authUrl || authUrl.origin !== authOrigin ||
    !Number.isSafeInteger(nowMs) || nowMs <= 0 ||
    !Array.isArray(allowedRedirects) || allowedRedirects.length === 0 ||
    allowedRedirects.length > 10 ||
    !allowedRedirects.every((entry) => {
      const url = cleanHttpsUrl(entry);
      return url && url.pathname === "/reset-password.html" && !url.search &&
        url.href === entry;
    }) || !allowedRedirects.includes(redirectTo)
  ) fail("configuration_invalid");
  return Object.freeze({
    reservedUserId,
    canonicalEmail,
    redirectTo,
    authOrigin,
    nowMs,
  });
}

type Binding = ReturnType<typeof snapshot>;

function sameEmail(value: unknown, binding: Binding) {
  return typeof value === "string" && value === value.trim() &&
    value.toLowerCase() === binding.canonicalEmail;
}

function validateNewUser(value: unknown, binding: Binding) {
  if (
    !record(value) || value.id !== binding.reservedUserId ||
    !sameEmail(value.email, binding)
  ) fail("account_changed");
  const ban = value.banned_until;
  const identities = value.identities;
  // A bootstrap account has no prior password owner, login, linked provider,
  // pending email change, or MFA factor. Confirmation means setup progressed;
  // return to the normal authenticated continuation, do not issue another link.
  if (
    value.is_anonymous !== false || value.is_sso_user === true ||
    value.aud !== "authenticated" || value.role !== "authenticated" ||
    !absent(value.deleted_at) || !absent(value.email_confirmed_at) ||
    !absent(value.confirmed_at) || !absent(value.phone_confirmed_at) ||
    !absent(value.last_sign_in_at) ||
    (!absent(value.phone) && value.phone !== "") ||
    (!absent(value.new_email) && value.new_email !== "") ||
    (!absent(value.new_phone) && value.new_phone !== "") ||
    (!absent(ban) &&
      (typeof ban !== "string" || !Number.isFinite(Date.parse(ban)) ||
        Date.parse(ban) > binding.nowMs)) ||
    (!absent(value.factors) &&
      (!Array.isArray(value.factors) || value.factors.length !== 0)) ||
    !Array.isArray(identities) || identities.length !== 1 ||
    !record(identities[0]) || identities[0].provider !== "email" ||
    identities[0].user_id !== binding.reservedUserId ||
    !record(identities[0].identity_data) ||
    !sameEmail(identities[0].identity_data.email, binding)
  ) fail("account_conflict");
}

function successfulData(value: unknown): Record<string, unknown> | null {
  return record(value) && value.error === null && record(value.data)
    ? value.data
    : null;
}

function recoveryActionLink(properties: unknown, binding: Binding): string {
  if (
    !record(properties) || properties.verification_type !== "recovery" ||
    properties.redirect_to !== binding.redirectTo ||
    typeof properties.hashed_token !== "string" ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(properties.hashed_token)
  ) fail("recovery_link_invalid");
  const link = cleanHttpsUrl(properties.action_link);
  if (
    !link || link.origin !== binding.authOrigin ||
    link.pathname !== "/auth/v1/verify" ||
    [...link.searchParams.keys()].length !== 3 ||
    link.searchParams.getAll("type").length !== 1 ||
    link.searchParams.get("type") !== "recovery" ||
    link.searchParams.getAll("token").length !== 1 ||
    link.searchParams.get("token") !== properties.hashed_token ||
    link.searchParams.getAll("redirect_to").length !== 1 ||
    link.searchParams.get("redirect_to") !== binding.redirectTo
  ) fail("recovery_link_invalid");
  return link.href;
}

/**
 * At most one create, one by-ID reconciliation, and one link generation. No
 * email lookup, invite fallback, password assignment, confirmation or mail send.
 * A generation/dispatch lease and retry classification belong to the caller.
 */
export async function bootstrapNewEarlyAccessAccount(
  input: EarlyAccessAuthBootstrapInput,
  dependencies: EarlyAccessAuthBootstrapDependencies,
): Promise<ServerOnlyEarlyAccessRecoveryMail> {
  try {
    const binding = snapshot(input);
    let created: unknown;
    try {
      // Admin create is create-only even for an existing unconfirmed mailbox.
      // Omitting both password fields makes Auth generate an unknown password.
      created = await dependencies.createUser({
        id: binding.reservedUserId,
        email: binding.canonicalEmail,
        email_confirm: false,
      });
    } catch {
      // The request may have committed. Reconcile the durable UUID, not email.
    }
    const createdData = successfulData(created);
    if (createdData) {
      validateNewUser(createdData.user, binding);
    } else {
      let found: unknown;
      try {
        found = await dependencies.getUserById(binding.reservedUserId);
      } catch {
        fail("account_unavailable");
      }
      const foundData = successfulData(found);
      if (!foundData) fail("account_unavailable");
      // A duplicate mailbox with no account at the reserved UUID fails here.
      if (!foundData.user) fail("account_conflict");
      validateNewUser(foundData.user, binding);
    }

    let generated: unknown;
    try {
      generated = await dependencies.generateLink({
        type: "recovery",
        email: binding.canonicalEmail,
        options: { redirectTo: binding.redirectTo },
      });
    } catch {
      fail("recovery_link_unavailable");
    }
    const generatedData = successfulData(generated);
    if (!generatedData) fail("recovery_link_unavailable");
    // generateLink addresses a mailbox: recheck its resulting user before the
    // native capability can enter private mail material. Never mail a new owner.
    validateNewUser(generatedData.user, binding);
    return Object.freeze({
      userId: binding.reservedUserId,
      recipient: binding.canonicalEmail,
      recoveryActionLink: recoveryActionLink(generatedData.properties, binding),
    });
  } catch (error) {
    if (error instanceof EarlyAccessAuthBootstrapError) throw error;
    fail("bootstrap_unavailable");
  }
}
