/**
 * Agent Connections V1 (Issue #141 r15) — the identity rules two services have
 * to agree on, in the one package both already depend on.
 *
 * The Admin and the authorization service each need to know what a client id
 * is and which clients are registered. They cannot import each other, and a
 * copy on each side is not a shared rule: it is two rules that agree until the
 * day one is edited. A registry the Admin validated more loosely than the
 * provider would show the Owner one client while the provider authorized
 * another — which is exactly the disagreement a consent screen exists to
 * prevent.
 *
 * WHY HERE, and not in `@moya/contracts`: the Community V1 freeze (amendment
 * 2026-09-11, section 9) pins `packages/contracts/src/internal` to exactly
 * three subpaths, and a fourth is a policy change this task has no authority
 * to make. This package is the next-closest shared home — both consumers
 * already depend on it, and these rules bound values its own columns store
 * (`oauth_client_id` is CHECKed between 1 and 1024 characters right here).
 *
 * Carry-forward C2 from the r14 review named the move; the freeze named the
 * destination.
 *
 * Deliberately zod-free. This package has never depended on zod and there is
 * no reason a persistence package should start: the RULES live here as plain
 * predicates, and the one consumer that wants them as zod schemas builds those
 * from these predicates rather than the other way round.
 */

export class RegisteredClientError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`registered clients refused: ${code}`);
    this.name = "RegisteredClientError";
    this.code = code;
  }
}

/**
 * Onboarding PRESETS, not a vocabulary. These three are the surfaces the Admin
 * offers a one-click setup for; they are a convenience and an icon, and they
 * have never been an authorization input.
 *
 * WHY THIS IS NO LONGER AN ALLOWLIST. ArtVenn is a tool service, not a client
 * directory: an approved client must be registrable through configuration, and
 * one enum value per vendor is a schema change per vendor. What decides
 * authority is the exact registered `oauth_client_id`, the human's identity,
 * the resource, the consent, the frozen scopes and the generation — none of
 * which this label touches. `admitGrant` never reads it, the grant table has
 * no column for it, and `findForClient` matches on the client id.
 *
 * So the family is now a bounded SLUG with a display `label` beside it. The
 * bound is real: it is templated into `principal_label`
 * (`agent-<family>-<12 hex>`), whose own CHECK is `^agent-[a-z0-9-]{2,57}$`,
 * so 32 characters of slug plus the fixed 19 stays inside it with room to
 * spare.
 */
export const CONNECTION_CLIENT_PRESETS = Object.freeze([
  "claude",
  "codex",
  "cursor",
] as const);
export type ConnectionClientPreset = (typeof CONNECTION_CLIENT_PRESETS)[number];

/** Lower-case, no underscores, no leading dash: safe inside a principal label. */
export const CONNECTION_CLIENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;

export const isConnectionClientSlug = (value: unknown): value is string =>
  typeof value === "string" && CONNECTION_CLIENT_PATTERN.test(value);

/**
 * A client id is bounded because it is carried in a bearer claim, compared
 * against a frozen grant and written into a database column. An unbounded
 * identifier is a different problem in each of those places.
 */
export const CLIENT_ID_MAX_BYTES = 1024;

const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).length;

/** Control characters have no place in an identifier presented as a bearer claim. */
const hasControlCharacters = (value: string): boolean =>
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  /[\u0000-\u001f\u007f]/u.test(value);

/** Form 1: a preregistered opaque identifier, matched exactly. */
export const isPreregisteredClientId = (value: string): boolean =>
  value.length > 0 &&
  value === value.trim() &&
  !hasControlCharacters(value) &&
  !value.includes("://") &&
  utf8Bytes(value) <= CLIENT_ID_MAX_BYTES;

/**
 * Form 2: a CIMD client id, which is a canonical HTTPS URL. No userinfo (it
 * would carry a credential), no fragment (it is not part of the identity the
 * provider recognizes), and canonical — the stored value must be exactly what
 * the provider recognized, so a non-canonical spelling is refused rather than
 * normalized into agreement.
 */
export const isCimdClientId = (value: string): boolean => {
  if (hasControlCharacters(value)) return false;
  if (utf8Bytes(value) > CLIENT_ID_MAX_BYTES) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.hash !== "") return false;
  // Canonical: what we were given must equal what the URL parser round-trips,
  // so two spellings of one URL cannot become two identities.
  return url.href === value;
};

/** The one rule: a bounded opaque identifier, or a canonical HTTPS CIMD URL. */
export const isOauthClientId = (value: unknown): value is string =>
  typeof value === "string" &&
  (isPreregisteredClientId(value) || isCimdClientId(value));

/**
 * How a registration's callback URIs are judged. A POLICY NAME on the
 * registration, never a branch on the client's family: a rule that reads
 * `if (family === "cursor")` is a rule that has to be edited for the next
 * client, and it makes a descriptive label decide a security question.
 *
 *   `loopback-ip`     http:// on 127.0.0.1 or [::1] only. The strictest, and
 *                     the default for anything that does not say otherwise.
 *   `loopback-host`   additionally admits the literal host `localhost`, and
 *                     then requires an explicit port and a real path.
 *   `hosted-https`    one exact `https:` callback on a vendor's public host,
 *                     for a tool that runs in the vendor's cloud. Refused
 *                     unless the caller allows it (`parseRegisteredClients`).
 *
 * `loopback-host` exists because real native clients publish a `localhost`
 * callback — Cursor Desktop's is exactly `http://localhost:8787/callback` —
 * and refusing the spelling refuses the client. The honest statement of the
 * tradeoff is in `parseRedirectUris` below; it is a tradeoff, not a free win.
 */
export const CALLBACK_POLICIES = Object.freeze([
  "loopback-ip",
  "loopback-host",
  "hosted-https",
] as const);
export type CallbackPolicy = (typeof CALLBACK_POLICIES)[number];

export const isCallbackPolicy = (value: unknown): value is CallbackPolicy =>
  typeof value === "string" &&
  (CALLBACK_POLICIES as readonly string[]).includes(value);

/** One registered client, as BOTH sides read it from one setting. */
export interface RegisteredClient {
  readonly clientId: string;
  /** A bounded slug. Descriptive, never authenticated. */
  readonly family: string;
  readonly label: string;
  /** Which callback shapes this registration may use. */
  readonly callbackPolicy: CallbackPolicy;
  /**
   * Where the provider may send this client back. The Admin never redirects
   * anywhere near it — it is validated here because this is ONE setting read
   * by both sides, and a registry validated differently on each side is a
   * registry that agrees right up until it matters.
   */
  readonly redirectUris: readonly string[];
}

/** Hosts each loopback policy will accept. Never a wildcard, never a suffix match. */
const POLICY_HOSTS: Readonly<
  Record<Exclude<CallbackPolicy, "hosted-https">, readonly string[]>
> = {
  "loopback-ip": ["127.0.0.1", "[::1]"],
  "loopback-host": ["127.0.0.1", "[::1]", "localhost"],
};

/**
 * One hosted callback: an exact `https:` URL on a named public host, with a real
 * path and nothing else. `oidc-provider` matches it byte for byte, because its
 * ephemeral-port exception covers only `http:` loopback, so this is the one
 * policy where what the registry stores is what the provider enforces.
 *
 * The host pattern needs two labels and a final label that starts with a
 * letter, so an address, a bare intranet name and `localhost` are all refused;
 * the provider's own client schema also refuses `https:` loopback on a native
 * client, at startup. The round trip refuses `:443`, which the parser drops.
 * The entry itself is searched for `?` and `#`, because a bare one reads back
 * as an empty `search` or `hash` and survives the round trip.
 */
const HOSTED_CALLBACK_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$/u;

const isHostedCallback = (url: URL, entry: string): boolean =>
  url.protocol === "https:" &&
  HOSTED_CALLBACK_HOST.test(url.hostname) &&
  url.username === "" &&
  url.password === "" &&
  url.port === "" &&
  !/[?#]/u.test(entry) &&
  url.pathname !== "/" &&
  url.href === entry;

/**
 * A client's redirect URIs, exactly as the provider will have to match them.
 *
 * A native client's loopback redirect is the default shape, and anything else
 * is refused rather than passed through: a redirect target is where an
 * authorization code is delivered, so a registry that accepted a remote host
 * by default would be the whole flow's weakest link. `hosted-https` is the one
 * exception, asked for in writing per registration and allowed per caller.
 *
 * WHAT EACH REGISTRATION BUYS BY CHOOSING `loopback-host`, stated as a
 * tradeoff rather than as a reassurance:
 *
 *   * `127.0.0.1` and `[::1]` are addresses; the kernel decides what they mean
 *     and nothing in userspace can move them. `localhost` is a NAME, and a
 *     name is resolved — a hosts file, a resolver or an mDNS responder can
 *     point it somewhere else. That is the whole of the difference, and it is
 *     why `loopback-ip` stays the default.
 *   * What still holds either way: the scheme must be `http:`, the path must
 *     be a real path, there is no userinfo, no fragment and no query, and the
 *     stored form must be byte-identical to what was written — so a
 *     `localhost` registration is never quietly rewritten to an IP, and an IP
 *     registration never quietly accepts the name.
 *   * What does NOT hold, and must not be claimed: the PORT is not pinned at
 *     match time. `oidc-provider` matches a native client's loopback redirect
 *     with the RFC 8252 §7.3 ephemeral-port exception (`stripLoopbackPort` in
 *     its `models/client.js`, over the same three hosts), so any port on the
 *     registered host and path is accepted by the provider whatever this
 *     registry stores. Requiring an explicit port here is defence in depth and
 *     a readability rule — it is not a guarantee, and reading it as one would
 *     be the kind of comment this task has had to retract before.
 */
const parseRedirectUris = (
  value: unknown,
  policy: CallbackPolicy,
): readonly string[] => {
  if (!Array.isArray(value) || value.length === 0)
    throw new RegisteredClientError("CLIENTS_MALFORMED");
  return value.map((entry) => {
    if (typeof entry !== "string")
      throw new RegisteredClientError("CLIENTS_MALFORMED");
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new RegisteredClientError("CLIENTS_MALFORMED");
    }
    if (policy === "hosted-https") {
      if (!isHostedCallback(url, entry))
        throw new RegisteredClientError("CLIENTS_REDIRECT_NOT_HOSTED");
      return entry;
    }
    if (
      url.protocol !== "http:" ||
      !POLICY_HOSTS[policy].includes(url.hostname) ||
      url.hash !== "" ||
      url.search !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      // A real path. `/` is the closest thing a URL has to a wildcard here,
      // and a registration that accepts the root accepts every deep link a
      // future bug might build under it.
      url.pathname === "/" ||
      url.pathname === "" ||
      // An explicit port, so the registration says what it means even though
      // the provider will not enforce it (see the note above).
      url.port === "" ||
      // The guarantee that no spelling is normalized on the way in.
      url.href !== entry
    )
      throw new RegisteredClientError("CLIENTS_REDIRECT_NOT_LOOPBACK");
    return entry;
  });
};

/**
 * Parses the registry, refusing anything it cannot read exactly.
 *
 * A malformed entry is a startup refusal rather than a skipped row: a registry
 * that silently dropped a client would make the Admin show nothing where the
 * provider will happily authorize something, and the Owner would be consenting
 * to a screen that had quietly omitted it.
 *
 * `allowHosted` defaults to false, so a caller that does not say otherwise,
 * Article among them, stays loopback only and refuses a hosted entry at startup.
 */
export const parseRegisteredClients = (
  value: string,
  options: { readonly allowHosted?: boolean } = {},
): ReadonlyMap<string, RegisteredClient> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RegisteredClientError("CLIENTS_MALFORMED");
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new RegisteredClientError("CLIENTS_REQUIRED");
  const clients = new Map<string, RegisteredClient>();
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new RegisteredClientError("CLIENTS_MALFORMED");
    const record = entry as Record<string, unknown>;
    // `callbackPolicy` is OPTIONAL and defaults to the strict policy, so an
    // existing registration keeps exactly the rule it was written under and a
    // wider rule is something a registration has to ASK for in writing.
    const keys = Object.keys(record).sort().join(",");
    if (
      (keys !== "clientId,family,label,redirectUris" &&
        keys !== "callbackPolicy,clientId,family,label,redirectUris") ||
      typeof record.label !== "string" ||
      record.label.trim() !== record.label ||
      record.label.length === 0 ||
      record.label.length > 64
    )
      throw new RegisteredClientError("CLIENTS_MALFORMED");
    // KEY PRESENCE, not `??`. A nullish coalesce reads an explicit
    // `"callbackPolicy": null` as "use the default", which is a malformed
    // entry silently upgraded into a valid one. Absent means default; present
    // means it must be a policy this code knows.
    const callbackPolicy = Object.hasOwn(record, "callbackPolicy")
      ? record.callbackPolicy
      : "loopback-ip";
    if (!isCallbackPolicy(callbackPolicy))
      throw new RegisteredClientError("CLIENTS_MALFORMED");
    if (callbackPolicy === "hosted-https" && options.allowHosted !== true)
      throw new RegisteredClientError("CLIENTS_HOSTED_NOT_ALLOWED");
    const redirectUris = parseRedirectUris(record.redirectUris, callbackPolicy);
    if (
      !isOauthClientId(record.clientId) ||
      !isConnectionClientSlug(record.family)
    )
      throw new RegisteredClientError("CLIENTS_MALFORMED");
    // Two entries for one client id is an ambiguity, not a later-wins rule.
    if (clients.has(record.clientId))
      throw new RegisteredClientError("CLIENTS_DUPLICATED");
    clients.set(record.clientId, {
      clientId: record.clientId,
      family: record.family,
      label: record.label,
      callbackPolicy,
      redirectUris,
    });
  }
  return clients;
};
