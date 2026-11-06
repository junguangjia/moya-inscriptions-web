import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { RESUME_SECRET_PARAMETER } from "@moya/community-postgres";
import { z } from "zod";

import {
  PRESET_CAPABILITY_SCOPES,
  PROTOCOL_ONLY_SCOPES,
  oauthClientIdSchema,
} from "./contracts";

import type { ConnectionPreset } from "./contracts";
import type { RegisteredClient } from "@moya/community-postgres";

/**
 * Agent Connections V1 (Issue #141 r15 §5) — the consent transaction, without
 * a framework.
 *
 * Nothing here imports payload, next or pg. That is not tidiness: the r14
 * review found that pulling `payload` into the fast test lane cost 1.7s and
 * turned three green runs into one failure in three, so the rules a consent
 * decision rests on live where they can be tested in milliseconds.
 *
 * The shape is dictated by one measured fact. The Owner's Payload session is
 * `SameSite=Strict`, and the provider's cross-site redirect does NOT carry it:
 *
 *   admin.localhost sees                    probe_strict=S
 *   auth.localhost sees                     (none)
 *   admin after cross-site nav from auth    (none)   <- the redirect itself
 *   admin after a same-site step            probe_strict=S
 *
 * So the page the provider sends the browser to cannot authenticate anybody,
 * and no redirect chain fixes that. One same-origin step follows; the page after
 * it has a session, and only that page mints the ticket. A POST that cannot
 * produce the ticket did not come from a page this server rendered to this
 * human — which is the CSRF property, obtained without weakening a cookie.
 *
 * Under the Development read-only profile that step is the human's own click.
 * Under `operator` the landing takes it with a meta refresh, measured to carry
 * the session (the record's section 22), so a navigation started elsewhere can
 * reach the review and arm a ticket. That is harmless for the reasons above: the
 * ticket is readable only on this origin, the POST that spends it also needs a
 * click, a same-origin `Origin` and the Strict cookie, and the provider resumes
 * only with the one-time secret that POST returned, beside its own cookie.
 */

/** A refusal with a bare code. Never a message that could carry a value. */
export class ConsentError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) {
    super(`consent refused: ${code}`);
    this.name = "ConsentError";
    this.code = code;
    this.status = status;
  }
}

/**
 * The interaction uid, as it may appear in a URL. Deliberately narrow: the uid
 * is reflected into a page and into a redirect, so anything that is not an
 * opaque identifier is refused before it reaches either.
 */
export const interactionUidSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u, "interaction uid must be opaque");

/** The ticket, as the form returns it. 32 bytes, hex. */
export const consentTicketSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "ticket must be 32 bytes of hex");

/**
 * The POST body. `decision` is an explicit word, never a truthy field: a
 * request that merely arrives must not read as approval, and a body missing
 * the field is refused rather than defaulted.
 */
export const consentDecisionSchema = z
  .object({
    interaction: interactionUidSchema,
    ticket: consentTicketSchema,
    decision: z.enum(["approve", "deny"]),
  })
  .strict();

export type ConsentDecisionRequest = z.infer<typeof consentDecisionSchema>;

/**
 * Mints a single-use ticket and the digest that is all the server keeps.
 *
 * The ticket never leaves the page it was rendered into, and the digest is
 * what the WHERE clause compares. Storing the ticket itself would mean a read
 * of the consent table yielded something usable, which is the property this
 * avoids for exactly the same reason wrappers store a digest.
 */
export const mintConsentTicket = (): {
  readonly ticket: string;
  readonly digest: string;
} => {
  const ticket = randomBytes(32).toString("hex");
  return { ticket, digest: digestConsentTicket(ticket) };
};

export const digestConsentTicket = (ticket: string): string =>
  createHash("sha256").update(ticket, "utf8").digest("hex");

/**
 * Constant-time ticket comparison, for a caller that has to compare two
 * tickets in process rather than in a WHERE clause.
 *
 * Nothing in the product calls it today: every comparison that matters is the
 * `decide` statement's own WHERE clause, which is the stronger arrangement
 * because it leaves no check-then-act window. An earlier version of this note
 * claimed it was "the one place" such a comparison happens, which an
 * independent review correctly read as describing a caller that does not
 * exist. Kept because a future caller that needs it should not reach for
 * `===`, and lengths are checked first because `timingSafeEqual` throws on a
 * mismatch and a throw is itself a signal.
 */
export const consentTicketsEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * What the human is shown, and what the decision is therefore bound to.
 *
 * Every field comes from the row the PROVIDER wrote — never from the request,
 * never from a query parameter, never from a token the caller supplied.
 * Expected authority comes from trusted configuration and the frozen consent.
 */
export interface ConsentDisplay {
  readonly interaction: string;
  readonly client: string;
  readonly resource: string;
  readonly environment: string;
  readonly capabilities: readonly string[];
  readonly protocol: readonly string[];
  readonly preset: ConnectionPreset;
  readonly expiresAt: string;
  /** Under `operator`, what the page says in the person's words. */
  readonly tool?: ConsentTool;
}

/**
 * The tool as an administrator reads about it. All of it comes from the closed
 * list, never from the request: a stranger can start a real request for a listed
 * client, and can choose neither what it is called nor where the browser returns.
 */
export interface ConsentTool {
  readonly label: string;
  /** Who its model provider is, where the content it reads goes. */
  readonly vendor: string;
  /** The hostnames the browser may return to, a local tool's loopback included. */
  readonly callbackHosts: readonly string[];
  /** The callback is on this computer, not on the vendor's site. */
  readonly local: boolean;
}

/**
 * The model provider behind each family on the closed list. The public policy names
 * these three, so another vendor needs the policy text changed first, and then a line
 * here; a release ships the policy before the Admin that carries the line. A family
 * with no line stops at the consent page, which could not otherwise say where the
 * content goes. Cursor passes what it reads on to the model the person picks in it,
 * as the policy says, so its line names both.
 */
const TOOL_VENDORS: ReadonlyMap<string, string> = new Map([
  ["claude", "Anthropic"],
  ["claude-code", "Anthropic"],
  ["codex", "OpenAI"],
  ["chatgpt", "OpenAI"],
  ["cursor", "Anysphere，以及你在 Cursor 里选用的模型的提供方"],
]);

const consentToolOf = (
  registered: RegisteredClient | undefined,
): ConsentTool => {
  if (registered === undefined) throw new ConsentError("CLIENT_NOT_REGISTERED");
  const vendor = TOOL_VENDORS.get(registered.family);
  if (vendor === undefined) throw new ConsentError("CLIENT_VENDOR_NOT_NAMED");
  return {
    label: registered.label,
    vendor,
    callbackHosts: [
      ...new Set(registered.redirectUris.map((uri) => new URL(uri).hostname)),
    ],
    local: registered.callbackPolicy !== "hosted-https",
  };
};

/**
 * A request that asks for more than its preset is REFUSED rather than quietly
 * narrowed, and this is where.
 *
 * Silently dropping `artvenn:manage` from a read-only request would hand back a
 * token that works, having ignored what was asked for — the caller would believe
 * it had management and find out by being denied later, and the Owner would have
 * approved a screen that did not say so. An unsupported capability is an error,
 * exactly as an unsupported resource is.
 */
const admitCapabilities = (
  preset: ConnectionPreset,
  requested: readonly string[],
): readonly string[] => {
  const allowed = new Set<string>(PRESET_CAPABILITY_SCOPES[preset]);
  const protocolOnly = new Set<string>(PROTOCOL_ONLY_SCOPES);
  const capabilities: string[] = [];
  for (const scope of requested) {
    if (protocolOnly.has(scope)) continue;
    if (!allowed.has(scope)) throw new ConsentError("SCOPE_NOT_AVAILABLE");
    capabilities.push(scope);
  }
  if (capabilities.length === 0) throw new ConsentError("SCOPE_REQUIRED");
  return [...new Set(capabilities)].sort();
};

export const admitReadOnlyCapabilities = (
  requested: readonly string[],
): readonly string[] => admitCapabilities("read-only", requested);

/**
 * Builds the display from the stored interaction, refusing anything that does
 * not belong on a consent screen.
 *
 * `deadline` is passed rather than read from a clock so the caller decides
 * what "now" is; a page that renders an already-dead interaction as live is
 * the failure this prevents.
 *
 * `servedPreset` is what this deployment grants, and the row must say the same.
 * `registered` is the closed list's entry for the row's client, which only the
 * `operator` wording reads.
 */
export const describeConsent = (input: {
  readonly interactionUid: string;
  readonly oauthClientId: string;
  readonly resource: string;
  readonly capabilityScopes: readonly string[];
  readonly protocolScopes: readonly string[];
  readonly preset: ConnectionPreset;
  readonly servedPreset: ConnectionPreset;
  readonly registered: RegisteredClient | undefined;
  readonly expiresAt: string;
  readonly environment: string;
  readonly now: Date;
}): ConsentDisplay => {
  const interaction = interactionUidSchema.safeParse(input.interactionUid);
  if (!interaction.success) throw new ConsentError("INTERACTION_MALFORMED");
  const client = oauthClientIdSchema.safeParse(input.oauthClientId);
  if (!client.success) throw new ConsentError("CLIENT_MALFORMED");
  const deadline = Date.parse(input.expiresAt);
  if (!Number.isFinite(deadline)) throw new ConsentError("INTERACTION_EXPIRY");
  if (deadline <= input.now.getTime())
    throw new ConsentError("INTERACTION_EXPIRED", 410);
  // The milestone gate, one layer above the CHECK constraint that also
  // refuses it. Both exist because a UI that could offer management would be
  // a defect even while the database refused to store it.
  if (input.preset !== input.servedPreset || input.preset === "management")
    throw new ConsentError("PRESET_NOT_AVAILABLE");
  return {
    interaction: interaction.data,
    client: client.data,
    resource: resourceOf(input.resource),
    environment: input.environment,
    capabilities: admitCapabilities(input.preset, input.capabilityScopes),
    protocol: [...input.protocolScopes]
      .filter((scope) => PROTOCOL_ONLY_SCOPES.includes(scope))
      .sort(),
    preset: input.preset,
    expiresAt: new Date(deadline).toISOString(),
    ...(input.preset === "operator"
      ? { tool: consentToolOf(input.registered) }
      : {}),
  };
};

/**
 * The resource, as an absolute origin-and-path URL with nothing that could
 * make two spellings of one audience. A resource the configuration does not
 * recognise is refused by the caller, not rewritten here.
 */
const resourceOf = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConsentError("RESOURCE_MALFORMED");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.hash || url.search)
    throw new ConsentError("RESOURCE_MALFORMED");
  return url.href;
};

/**
 * The same-origin continuation the landing page offers.
 *
 * It is built from the interaction uid alone and is ALWAYS a path on this
 * origin. A return URL taken from the request is exactly the
 * arbitrary-return-URL attempt §5 refuses, so no request field reaches it.
 */
/**
 * The path the provider redirects the browser to, and the prefix its
 * interaction cookie is scoped to. Shared by the landing route, the review
 * link and the resume URL so the three cannot drift apart.
 */
export const CONSENT_LANDING_PREFIX = "/agent-connections/consent";

export const consentReviewPath = (interactionUid: string): string => {
  const interaction = interactionUidSchema.safeParse(interactionUid);
  if (!interaction.success) throw new ConsentError("INTERACTION_MALFORMED");
  return `/admin/agent-connections/consent?interaction=${encodeURIComponent(interaction.data)}`;
};

/**
 * Where the browser goes AFTER the decision, to let the provider resume its
 * own interaction with its own cookie.
 *
 * The Owner's session never travels here: the decision is already stored, and
 * this navigation carries the uid and, for an `operator` approval, the one-time
 * resume secret. Only the browser that clicked allow receives that secret, and
 * the issuer needs it beside its own cookie. Built from the CONFIGURED issuer,
 * never from anything the caller sent.
 */
export const providerResumeUrl = (
  issuer: string,
  interactionUid: string,
  resumeSecret: string | null = null,
): string => {
  const interaction = interactionUidSchema.safeParse(interactionUid);
  if (!interaction.success) throw new ConsentError("INTERACTION_MALFORMED");
  let base: URL;
  try {
    base = new URL(issuer);
  } catch {
    throw new ConsentError("ISSUER_MALFORMED", 500);
  }
  if (!["http:", "https:"].includes(base.protocol) || base.search || base.hash)
    throw new ConsentError("ISSUER_MALFORMED", 500);
  // The same pathname the human's landing page uses, because oidc-provider
  // scopes its interaction cookie to exactly that path on the issuer's host.
  // A tidier `/interaction/<uid>/resume` is a route the browser reaches
  // without the cookie, and the resume then cannot find its interaction.
  const resume = new URL(
    `${base.pathname.replace(/\/$/u, "")}${CONSENT_LANDING_PREFIX}/${encodeURIComponent(interaction.data)}/resume`,
    base,
  );
  if (resumeSecret !== null)
    resume.searchParams.set(RESUME_SECRET_PARAMETER, resumeSecret);
  return resume.href;
};

/**
 * One registered client. The Admin needs three things the provider's registry
 * already holds: which client id it is, which vendor family to show, and what
 * to call it on screen.
 *
 * This is the SAME setting the authorization service reads, not a second copy
 * of it. Two registries would drift, and a drift here means the Admin shows
 * one client while the provider authorizes another. Nothing in it is secret:
 * a public client's id is public by construction.
 */
/**
 * The client registry is ONE setting both the Admin and the authorization
 * service read, so its rules live in the shared contract rather than here.
 * Re-exported for the callers that already import it from this module.
 */
export {
  RegisteredClientError,
  parseRegisteredClients,
} from "@moya/community-postgres";
export type { RegisteredClient } from "@moya/community-postgres";
