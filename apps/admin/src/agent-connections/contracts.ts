import { agentScopeSchema } from "@moya/contracts/internal/community-operator";
import { z } from "zod";

/**
 * Agent Connections V1 (Issue #141 r10) — the shapes a browser-consented
 * connection is made of.
 *
 * A connection is NOT a credential. It is the record of one human's consent
 * binding one vendor client, in one environment, to one restricted machine
 * principal with one permission preset. Tokens are minted against it and are
 * revoked by bumping its generation; the connection outlives them.
 */

/**
 * Client identity moved to `@moya/contracts/internal/agent-connections` in
 * r15, so the authorization service reads the SAME rules rather than a second
 * copy that agrees until the day one of them is edited. Re-exported here
 * because everything in the Admin already imports it from this module.
 */
export {
  CLIENT_ID_MAX_BYTES,
  CONNECTION_CLIENT_PRESETS,
  isCimdClientId,
  isPreregisteredClientId,
} from "@moya/community-postgres";
export type { ConnectionClientPreset } from "@moya/community-postgres";

import {
  CONNECTION_CLIENT_PATTERN,
  isOauthClientId,
} from "@moya/community-postgres";

/**
 * The zod spellings the Admin's schemas compose with, built FROM the shared
 * predicates rather than beside them. One rule, two shapes.
 *
 * A bounded slug, not an enum of vendor names: adding a client is a
 * registration, and an enum would make it a schema change.
 */
export const connectionClientSchema = z
  .string()
  .regex(CONNECTION_CLIENT_PATTERN);
export const oauthClientIdSchema = z.string().refine(isOauthClientId, {
  message:
    "a client id is a bounded opaque identifier or a canonical HTTPS CIMD URL",
});

/**
 * Three presets, and no fourth. `read-only` is the default for a new connection;
 * `management` still requires the Owner to approve every operation in the
 * Admin, so it grants the right to PREPARE and RUN an approved operation,
 * never the right to approve one. `operator` is what an administrator grants by
 * signing in; it holds no tool here, so the plugin path never serves it.
 */
export const connectionPresetSchema = z.enum([
  "read-only",
  "management",
  "operator",
]);
export type ConnectionPreset = z.infer<typeof connectionPresetSchema>;

/**
 * The business scopes each preset consents to, expressed in the Backend's own
 * seven-scope vocabulary so the two can never drift into separate dialects.
 * A preset is a consent shorthand; the Backend still enforces the scope.
 */
export const PRESET_SCOPES: Readonly<
  Record<ConnectionPreset, readonly z.infer<typeof agentScopeSchema>[]>
> = {
  "read-only": ["users:read", "content:read", "comments:read"],
  management: [
    "users:read",
    "content:read",
    "comments:read",
    "comments:moderate",
    "featured:write",
    "operations:execute",
    "operations:undo",
  ],
  operator: [],
};

/**
 * The MCP tools each preset may call. Derived from the preset rather than from
 * the token, so a token can never widen what its connection consented to.
 *
 * The five `editorial_*` tools are deliberately absent from both presets: a
 * connection is an Agent Administration identity and never inherits the
 * separate editorial domain, whatever its bearer presents.
 */
export const PRESET_TOOLS: Readonly<
  Record<ConnectionPreset, readonly string[]>
> = {
  // `artvenn_operations_get` is deliberately ABSENT here. The Backend
  // authorizes it under `operations:execute`
  // (agent-administration-service.ts `get`), which the read-only preset does
  // not hold, so advertising it would put a tool in `tools/list` that the
  // Backend then refuses. The fix is to stop advertising it, not to widen the
  // preset: a read-only connection must expose only tools whose COMPLETE
  // Backend path is read-only under the scopes it actually consented to.
  "read-only": [
    "artvenn_users_find",
    "artvenn_content_search",
    "artvenn_comments_query",
    "artvenn_comments_read",
  ],
  management: [
    "artvenn_users_find",
    "artvenn_content_search",
    "artvenn_comments_query",
    "artvenn_comments_read",
    "artvenn_operations_get",
    "artvenn_comments_prepare",
    "artvenn_featured_prepare",
    "artvenn_operations_execute",
    "artvenn_operations_cancel",
    "artvenn_operations_prepare_undo",
  ],
  operator: [],
};

/**
 * The tool map the plugin gates on. Absent means absent from `tools/list` as
 * well as refused on call, so a read-only connection never even sees the
 * management tools.
 */
export const toolGrants = (preset: ConnectionPreset): Record<string, boolean> =>
  Object.fromEntries(
    PRESET_TOOLS[preset].map((tool) => [toolGrantKey(tool), true]),
  );

/**
 * One canonical scope representation, so "the same scopes" never depends on
 * order, case or repetition. Normalization is total: anything it cannot
 * normalize is `null`, which is a refusal rather than a lenient reading.
 *
 * Duplicates are deliberately a failure rather than something to collapse. A
 * token that says `comments:read comments:read` was not minted by a provider
 * issuing this connection's canonical set, and quietly accepting it would mean
 * the resource server and the provider disagree about what a token says.
 */
/**
 * r11 §3 — THREE scope vocabularies, deliberately not one.
 *
 * The r10 model compared a token's scope claim against the Backend's seven
 * internal business scopes. That conflated two things that serve different
 * purposes and must be free to move independently:
 *
 *  - **Capability scopes** are the external OAuth contract. MCP clients pick
 *    these up from `WWW-Authenticate` and protected-resource metadata, so they
 *    are a published interface and stay small and stable.
 *  - **Protocol-only scopes** (`offline_access`) exist for the refresh
 *    lifecycle. They are accepted from a fixed allowlist and grant no ArtVenn
 *    capability whatsoever — a token holding only `offline_access` can call
 *    nothing.
 *  - **Internal Backend scopes** are the seven the Backend enforces. They are
 *    derived from the connection's preset and never read off a token, so a
 *    client cannot name them and cannot widen them.
 *
 * `openid` is deliberately absent from the allowlist: this is OAuth
 * authorization for an MCP resource, not an identity-token product. Adding it
 * would need a tested client integration that actually requires it.
 */
export const capabilityScopeSchema = z.enum([
  "artvenn:read",
  "artvenn:manage",
  "artvenn:admin",
]);
export type CapabilityScope = z.infer<typeof capabilityScopeSchema>;

/** Accepted for the refresh lifecycle; grants nothing. */
export const PROTOCOL_ONLY_SCOPES: readonly string[] = Object.freeze([
  "offline_access",
]);

/** The external capability scopes each preset consents to. */
export const PRESET_CAPABILITY_SCOPES: Readonly<
  Record<ConnectionPreset, readonly CapabilityScope[]>
> = Object.freeze({
  "read-only": Object.freeze(["artvenn:read"] as const),
  management: Object.freeze(["artvenn:read", "artvenn:manage"] as const),
  operator: Object.freeze(["artvenn:admin"] as const),
});

/** The exact capability set a token for this preset must carry. */
export const canonicalCapabilityScopes = (
  preset: ConnectionPreset,
): readonly string[] => [...PRESET_CAPABILITY_SCOPES[preset]].sort();

/** The internal Backend scopes a preset maps to. Never read off a token. */
export const canonicalScopes = (preset: ConnectionPreset): readonly string[] =>
  [...PRESET_SCOPES[preset]].sort();

export interface ScopeAdmission {
  readonly capabilities: readonly string[];
  readonly protocol: readonly string[];
}

/**
 * Splits a claim into capability and protocol scopes, or refuses it.
 *
 * Total: anything it cannot classify is `null`, which is a refusal rather than
 * a lenient reading. Duplicates fail rather than collapse — a claim repeating
 * a scope did not come from this connection's consent, and accepting it would
 * mean the resource server and the provider disagree about what a token says.
 * An internal Backend scope appearing in a claim is refused outright: those
 * are never part of the external contract, so seeing one means the token was
 * minted against a different model than this one.
 */
export const admitScopeClaim = (raw: unknown): ScopeAdmission | null => {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const capabilities: string[] = [];
  const protocol: string[] = [];
  const seen = new Set<string>();
  for (const scope of raw) {
    if (typeof scope !== "string") return null;
    if (scope !== scope.trim() || scope === "") return null;
    if (seen.has(scope)) return null;
    seen.add(scope);
    if (capabilityScopeSchema.safeParse(scope).success)
      capabilities.push(scope);
    else if (PROTOCOL_ONLY_SCOPES.includes(scope)) protocol.push(scope);
    // An internal Backend scope, `openid`, or anything unrecognised.
    else return null;
  }
  return {
    capabilities: [...capabilities].sort(),
    protocol: [...protocol].sort(),
  };
};

/**
 * Exact capability agreement, in both directions, with protocol-only scopes
 * ignored for the comparison and unable to affect it. A token with fewer
 * capabilities is not "safely narrower": it did not come from this
 * connection's consent, and an absent claim must never inherit the preset.
 */
export const scopesMatchPreset = (
  claimed: unknown,
  preset: ConnectionPreset,
): boolean => {
  const admitted = admitScopeClaim(claimed);
  if (admitted === null) return false;
  const expected = canonicalCapabilityScopes(preset);
  return (
    admitted.capabilities.length === expected.length &&
    admitted.capabilities.every((scope, index) => scope === expected[index])
  );
};

/**
 * r12 §4.1 — client identity, in two explicitly accepted forms.
 *
 * The r11 record claimed a "1024-byte" ceiling. That was false in the
 * permissive direction: Zod's `.max()` counts UTF-16 code units, so
 * `.max(1024)` accepts a 2048-byte value of accented characters. Bytes are
 * now measured as bytes.
 *
 * Rejection, never truncation: a truncated client id is a DIFFERENT id, and
 * silently matching a prefix of somebody's identity is the whole class of bug
 * exact-client binding exists to prevent.
 */
export const connectionStatusSchema = z.enum([
  "awaiting-consent",
  "authorized",
  "revoked",
]);
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

/**
 * `generation` is what makes disconnect real. Every token carries the
 * generation it was minted under; revoking bumps it, so an unexpired token, a
 * refresh and a live MCP session all fail their NEXT protected request
 * instead of waiting for a clock. It is not a timestamp comparison: a clock
 * that drifts cannot resurrect access.
 */
export const agentConnectionSchema = z.strictObject({
  id: z.string().min(1).max(128),
  principalLabel: z
    .string()
    .regex(/^agent-[a-z0-9-]{2,57}$/u, "a principal label starts with agent-"),
  humanAccountId: z.string().min(1).max(128),
  client: connectionClientSchema,
  /**
   * The EXACT registered OAuth client this connection authorized. The `client`
   * family above is descriptive metadata for the UI; this is the identity
   * authorization is decided on. A token minted for a different registered
   * client fails even when the human, connection, issuer, resource and
   * generation all agree.
   */
  /**
   * The exact provider-recognized client id, in one of two accepted forms.
   * See `oauthClientIdSchema`: a bounded opaque preregistered identifier, or a
   * canonical HTTPS CIMD metadata URL bounded by real UTF-8 BYTES.
   */
  oauthClientId: oauthClientIdSchema,
  environment: z.string().min(1).max(64),
  preset: connectionPresetSchema,
  status: connectionStatusSchema,
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /**
   * Canonical instant form, offset included. `z.iso.datetime({offset: false})`
   * rejects a bare local-looking timestamp under the installed zod, so the
   * lifecycle normalizes what it is given rather than storing a value its own
   * schema would refuse — which is what the r10 review found, invisible
   * because no test parsed the schema.
   */
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
  /** When the current consent was given. Null until a human has consented. */
  consentedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type AgentConnection = z.infer<typeof agentConnectionSchema>;

/**
 * What a verified access token asserts. Every field here IS checked against the
 * connection before anything is granted — subject, client, resource, issuer,
 * scopes and generation — so a token that is internally valid but disagrees
 * with its connection is refused rather than reconciled.
 */
/**
 * The immutable consent snapshot, as authorization sees it (r14 §4).
 *
 * This is the row `community.agent_connection_grants` froze at consent, and
 * it — not the connection — is what a token's identity is checked against.
 * The connection's own `oauthClientId` and `humanAccountId` stay writable by
 * design and no trigger freezes them, so taking identity from there would
 * reintroduce the mutable-identity hole the frozen generation exists to close.
 * The database says so itself, as a `COMMENT ON TABLE` in migration
 * 20260918040000.
 */
export interface ConsentSnapshot {
  readonly grantId: string;
  readonly connectionId: string;
  readonly generationAtConsent: number;
  readonly oauthClientId: string;
  readonly humanSubject: string;
  readonly issuer: string;
  readonly resource: string;
  readonly presetAtConsent: ConnectionPreset;
  /**
   * The capability scopes the human actually approved at the provider, frozen
   * with the rest of the snapshot. Until r14 this column existed and was never
   * read, so the one record of what was approved was decorative: authorization
   * derived the expected set from the preset alone, and a grant whose stored
   * scopes disagreed with its preset would never have been noticed.
   */
  readonly capabilityScopes: readonly string[];
  readonly consentedAt: string;
}

/**
 * What the store hands the boundary: the connection whose CURRENT state
 * decides revocation, and the frozen grant whose identity decides who.
 *
 * `grant` is null for a connection that has no current consent. That is a
 * refusal with a reason rather than an absence — reporting it as "no such
 * connection" would hide a real record behind a misleading code.
 */
export interface ConnectionRecord {
  readonly connection: AgentConnection;
  readonly grant: ConsentSnapshot | null;
}

export const verifiedGrantSchema = z.strictObject({
  connectionId: z.string().min(1).max(128),
  subject: z.string().min(1).max(128),
  // The same two accepted forms as the connection's `oauthClientId`: a client
  // id that can be stored but never matched is a permanently dead
  // registration, and the two sides must therefore agree exactly.
  clientId: oauthClientIdSchema,
  /** RFC 8707 resource indicator: which ArtVenn resource this token is for. */
  resource: z.string().min(1).max(512),
  issuer: z.string().min(1).max(512),
  scopes: z.array(z.string().min(1).max(64)).max(32),
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /**
   * When the token stops being valid. Carried here and checked in `admitGrant`
   * so expiry is this boundary's business rather than an unstated assumption
   * about what the verifier happens to enforce.
   */
  expiresAt: z.iso.datetime({ offset: true }),
});
export type VerifiedGrant = z.infer<typeof verifiedGrantSchema>;

/**
 * ArtVenn connection access tokens carry this prefix so `overrideAuth` can
 * tell them from a legacy Payload MCP API key DELIBERATELY, rather than by
 * trying one path and falling through to the other on failure. Falling
 * through is exactly the confused-deputy shape this prefix exists to prevent:
 * once a presented credential claims to be ours, it succeeds on its own terms
 * or it is refused.
 */
export const CONNECTION_TOKEN_PREFIX = "artvenn_ct_";

/**
 * The plugin gates tools on a CAMEL-CASED key: `getMcpHandler` computes
 * `toCamelCase(tool.name)` and looks that up in `payload-mcp-tool`, defaulting
 * to `false` when it is absent. A grant map keyed by the raw snake_case tool
 * name therefore disables every tool silently — the r10 review caught exactly
 * that, after the map had been written, tested and shipped in the wrong shape.
 *
 * This mirrors the plugin's own conversion. The regression that guards it
 * imports the plugin's `toCamelCase` and compares, rather than trusting this
 * copy to stay in step.
 */
export const toolGrantKey = (toolName: string): string =>
  toolName
    .replace(/[-_\s]+(.)?/gu, (_, character: string | undefined) =>
      character ? character.toUpperCase() : "",
    )
    .replace(/^(.)/u, (_, character: string) => character.toLowerCase());

export const isConnectionToken = (presented: string): boolean =>
  presented.startsWith(CONNECTION_TOKEN_PREFIX);

/** The one instant form this module accepts anywhere: explicit offset, no guessing. */
export const instantSchema = z.iso.datetime({ offset: true });

/** Refusals carry a bare stable code; they never echo the presented token. */
export class ConnectionAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ConnectionAuthError";
  }
}

/**
 * Normalizes an instant to the canonical form `agentConnectionSchema` accepts.
 * Throws rather than storing a value the schema would later reject.
 */
export const canonicalInstant = (value: unknown): string => {
  // Validated BEFORE it is interpreted. `new Date(value)` accepts far more
  // than the schema's canonical form and reads an offset-less timestamp as
  // HOST LOCAL TIME, so the same input would store a different instant
  // depending on the server's TZ — the r10 review caught that as blocker 2
  // moved one layer down. Only an explicit instant is accepted.
  if (!instantSchema.safeParse(value).success)
    throw new ConnectionAuthError("CONNECTION_TIMESTAMP_INVALID");
  return new Date(value as string).toISOString();
};
