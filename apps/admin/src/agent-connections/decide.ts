import { mintResumeSecret } from "@moya/community-postgres";

import {
  ConsentError,
  digestConsentTicket,
  providerResumeUrl,
} from "./consent";
import { authorizeConnection, reconnectConnection } from "./lifecycle";
import { provisionPrincipal } from "./principal";

import type { ConsentDecisionRequest } from "./consent";
import type { ConsentRuntime } from "./runtime";

/**
 * Agent Connections V1 (Issue #141 r15 §5) — the decision itself, separated
 * from the HTTP endpoint that calls it.
 *
 * It is here rather than inline so the committed regression can drive the
 * REAL decision rather than a re-typed copy of its write ordering. A test that
 * reimplements the order these three writes happen in would pass whatever the
 * product did.
 */

export interface ConsentOutcome {
  readonly decision: "approved" | "denied";
  /** Where the browser goes so the PROVIDER can resume its own interaction. */
  readonly resume: string;
}

/**
 * The decision.
 *
 * The order is the whole safety argument. There are TWO writes, not three —
 * the first step is a pure computation, and calling it a write was an
 * overstatement an independent review caught:
 *
 *  1. the pure transition is computed from the connection READ AT A VERSION,
 *     so the generation the consent will record is the one this decision
 *     would produce (no write);
 *  2. `decide` is the gate — the ticket, the human and the deadline are all
 *     in its WHERE clause, and a wrong ticket writes NOTHING. It runs before
 *     any connection change, because a failed decision that had already
 *     bumped a generation would have silently revoked live tokens;
 *  3. the connection is stored under compare-and-set at that version.
 *
 * If (3) loses a race the consent stands with a generation the connection
 * never reached, and the provider refuses to build a grant on it. That is the
 * fail-closed direction: an approval that grants nothing, never a grant
 * nobody approved.
 *
 * Under `operator` the same `decide` statement stores the digest of a one-time
 * secret, and only the answer to this request carries the secret itself. The
 * clients on that list are public, so a stranger can start a real request and
 * send the page to an administrator. The issuer finishes only with the secret and
 * its own cookie together, so the click reaches only a browser that holds both.
 */
export const decideConsent = async (
  runtime: ConsentRuntime,
  humanAccountId: string,
  body: ConsentDecisionRequest,
): Promise<ConsentOutcome> => {
  const digest = digestConsentTicket(body.ticket);

  if (body.decision === "deny") {
    const denied = await runtime.consents.decide({
      interactionUid: body.interaction,
      ticketDigest: digest,
      humanAccountId,
      decision: "denied",
      grantedGeneration: null,
    });
    if (denied === null) throw new ConsentError("CONSENT_NOT_DECIDABLE");
    return {
      decision: "denied",
      resume: providerResumeUrl(runtime.issuer, body.interaction),
    };
  }

  const consent = await runtime.consents.read(body.interaction);
  // Another person's armed review page, say two administrators in one browser, is
  // `decide`'s refusal too. Said here because the transition below would throw on it.
  if (
    consent === null ||
    consent.connectionId === null ||
    consent.humanAccountId !== humanAccountId
  )
    throw new ConsentError("CONSENT_NOT_DECIDABLE");
  // The resource the human was shown must be the resource this Admin is the
  // server for. A mismatch is refused, never rewritten to agree.
  if (consent.resource !== runtime.resource)
    throw new ConsentError("RESOURCE_NOT_AVAILABLE");
  if (consent.preset !== runtime.preset)
    throw new ConsentError("PRESET_NOT_AVAILABLE");
  // A tool taken off the list gets no new consent, from a page rendered before that.
  if (!runtime.clients.has(consent.oauthClientId))
    throw new ConsentError("CLIENT_NOT_REGISTERED");

  const stored = await runtime.connections.read(consent.connectionId);
  if (stored === null) throw new ConsentError("CONNECTION_NOT_FOUND", 404);
  const record = {
    humanAccountId,
    preset: runtime.preset,
    at: new Date().toISOString(),
  };
  // Reconnecting a revoked connection is a FRESH consent, never a
  // restoration; both paths raise the generation, which is what stops a token
  // from before the disconnect being admitted afterwards.
  const next =
    stored.connection.status === "revoked"
      ? reconnectConnection(stored.connection, record)
      : authorizeConnection(stored.connection, record);

  const resumeSecret =
    runtime.preset === "operator" ? mintResumeSecret() : null;
  const decided = await runtime.consents.decide({
    interactionUid: body.interaction,
    ticketDigest: digest,
    humanAccountId,
    decision: "approved",
    grantedGeneration: next.generation,
    resumeSecretDigest: resumeSecret?.digest ?? null,
  });
  if (decided === null) throw new ConsentError("CONSENT_NOT_DECIDABLE");

  // The machine principal, BETWEEN the decision and the connection write, and
  // the position is the safety argument again.
  //
  // By here the ticket, the human and the deadline have all been checked by
  // `decide`'s WHERE clause, so the consent is genuine and durable — this is
  // not provisioning on an unapproved request. And the connection has not yet
  // reached `next.generation`, so if this throws, the provider's resume finds
  // a connection that never moved and refuses the grant with CONNECTION_MOVED.
  // That is the same fail-closed direction the ordering above already argues
  // for: an approval that grants nothing, never a grant nobody approved.
  //
  // Doing it AFTER the connection write would produce the exact bug this
  // closes — an authorized connection whose every tool answers
  // AGENT_FORBIDDEN — with extra steps.
  //
  // An operator connection acts as the one `ai_operator` row, with no principal.
  if (runtime.preset === "read-only")
    await provisionPrincipal(
      runtime.principals,
      stored.connection,
      "read-only",
    );

  const written = await runtime.connections.compareAndSet(
    consent.connectionId,
    stored.version,
    next,
  );
  if (written === null) throw new ConsentError("CONNECTION_CHANGED", 409);

  return {
    decision: "approved",
    resume: providerResumeUrl(
      runtime.issuer,
      body.interaction,
      resumeSecret?.secret ?? null,
    ),
  };
};

/**
 * Stops every connection one person authorized, when they leave role owner or
 * change their password. Each is tried, so one failure does not spare the others,
 * and the first failure is then thrown for the caller to name.
 */
export const revokeConnectionsOf = async (
  runtime: Pick<ConsentRuntime, "authority" | "connections">,
  humanAccountId: string,
  at: string = new Date().toISOString(),
): Promise<void> => {
  const held = await runtime.connections.listForHuman(humanAccountId);
  const outcomes = await Promise.allSettled(
    held
      .filter(({ connection }) => connection.status !== "revoked")
      .map(({ connection }) => runtime.authority.revoke(connection.id, at)),
  );
  for (const outcome of outcomes)
    if (outcome.status === "rejected") throw outcome.reason;
};
