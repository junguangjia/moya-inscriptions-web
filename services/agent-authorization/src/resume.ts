import { digestResumeSecret, isResumeSecret } from "@moya/community-postgres";

import { plainPageHeaders, plainPageHtml } from "./plain-page.js";
import { PROFILE_GRANTS } from "./provider.js";

import type { ProviderBundle } from "./provider.js";

/**
 * Agent Connections V1 (Issue #141 r15 §5) — where a decision becomes a grant.
 *
 * The Admin recorded what the Owner decided; it could not finish the
 * interaction, because oidc-provider resumes an interaction from ITS own
 * cookie on ITS own origin, and the Admin is deliberately a different origin.
 * So the browser comes back here carrying nothing but the uid, and this route
 * reads the decision somebody else made.
 *
 * What it can and cannot do is a property of its SQL role, not of this file:
 * the provider role holds no privilege on `decision`, `decided_at`,
 * `granted_generation`, `human_account_id` or `connection_id`. It cannot
 * approve, cannot say who approved, and cannot re-point a decision. It may
 * mark an approved interaction spent, exactly once, and write the grant that
 * follows.
 *
 * Three checks stand between an approval and a grant, and each of them fails
 * closed:
 *
 *  1. the browser must hold this provider's own interaction cookie, and it
 *     must name THIS uid — a uid pasted into a bare browser resumes nothing;
 *  2. the consent must be approved, unspent and still within its deadline;
 *  3. the connection must still be at the generation the consent recorded.
 *     A connection revoked or re-consented while the browser was away no
 *     longer matches, and the grant is destroyed rather than bound to it.
 *
 * (3) is the r12 defect stated as a check. The generation is taken from the
 * CONSENT, never read from the connection at grant time: reading it here is
 * precisely how a token refreshed from an old grant came to resolve against
 * the current generation and be admitted.
 *
 * The `operator` profile needs one thing more (Issue #355, the Behavior Matrix's
 * Resume rows), because the clients on its list are public and have no secret
 * of their own. A stranger can start a real request in their own browser, send
 * the consent page to an administrator, wait for the click, and then finish the
 * interaction with the cookie they already hold. So approving also mints a
 * one-time secret, handed only to the browser that clicked, and this route needs
 * both halves: the cookie says who started the request, the secret says who
 * approved it.
 *
 *   cookie, secret   the grant, if (2) and (3) hold
 *   cookie alone     a plain page, and nothing changes
 *   secret alone     the consent is void, and a plain page says why
 *   neither          a plain page, and nothing changes
 *
 * A denied consent has no secret to carry, and its cookie's holder is told
 * `access_denied`. A cookie naming a different interaction counts as no cookie:
 * it says nothing about who started this one, and that other interaction is left
 * as it was.
 */

/**
 * A descendant of the interaction cookie's own path. See `CONSENT_PATH_PREFIX`
 * in provider.ts: oidc-provider scopes `_interaction` to the pathname of the
 * consent destination, so a resume route anywhere else is a route the browser
 * will visit without the cookie that identifies the interaction.
 */
export const RESUME_PATH =
  /^\/agent-connections\/consent\/([A-Za-z0-9_-]{1,256})\/resume$/u;

export interface ResumeOutcome {
  readonly handled: boolean;
  readonly code: string;
}

const PLAIN_PAGES = {
  refused: {
    title: "这次连接没有完成",
    body: "没有任何工具因此获得权限。请回到你的工具，重新点一次连接。",
  },
  voided: {
    title: "这次连接已作废",
    body: "这个连接请求不是从这个浏览器发起的，所以刚才的允许已经作废，没有任何工具因此获得权限。如果不是你自己在这个工具里点的连接，可能有人把链接发给了你，请告诉其他管理员。",
  },
} as const;

const plainPage = (
  response: import("node:http").ServerResponse,
  page: keyof typeof PLAIN_PAGES,
  code: string,
): ResumeOutcome => {
  const { title, body } = PLAIN_PAGES[page];
  response.statusCode = 400;
  for (const [name, value] of Object.entries(plainPageHeaders))
    response.setHeader(name, value);
  response.end(plainPageHtml(title, body));
  return { handled: true, code };
};

/**
 * The provider's own interaction, or null when this browser holds none. Only
 * that answer means no cookie: an outage reading it has to stay an outage, or a
 * database blip would look like a stranger's browser and void a real consent.
 */
const interactionOf = async (
  bundle: ProviderBundle,
  request: unknown,
  response: unknown,
) => {
  try {
    return await bundle.provider.interactionDetails(request, response);
  } catch (error) {
    if ((error as { name?: unknown }).name === "SessionNotFound") return null;
    throw error;
  }
};

/**
 * Finishes the interaction with an error the CLIENT will see, rather than
 * leaving a browser on a dead page. `access_denied` is the honest answer for
 * every refusal here: none of them tell the client anything about why, which
 * would otherwise be a probe.
 */
const deny = async (
  bundle: ProviderBundle,
  request: unknown,
  response: unknown,
  code: string,
): Promise<ResumeOutcome> => {
  await bundle.provider.interactionFinished(
    request,
    response,
    { error: "access_denied", error_description: "consent was not granted" },
    { mergeWithLastSubmission: false },
  );
  return { handled: true, code };
};

export const resumeInteraction = async (
  bundle: ProviderBundle,
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  uid: string,
  presentedSecret: string | null = null,
): Promise<ResumeOutcome> => {
  const { preset, capability } = PROFILE_GRANTS[bundle.config.profile];
  const operator = bundle.config.profile === "operator";
  const digest = isResumeSecret(presentedSecret)
    ? digestResumeSecret(presentedSecret)
    : null;

  // (1) The provider's own interaction, from the provider's own cookie. A uid
  // in a URL is a name; this is the only thing that makes it a session.
  const interaction = await interactionOf(bundle, request, response);
  if (operator && (interaction === null || interaction.uid !== uid)) {
    const voided =
      digest === null
        ? null
        : await bundle.consents.voidResume({
            interactionUid: uid,
            resumeSecretDigest: digest,
          });
    return voided === null
      ? plainPage(response, "refused", "INTERACTION_NOT_RESUMABLE")
      : plainPage(response, "voided", "CONSENT_VOIDED");
  }
  if (interaction === null)
    return plainPage(response, "refused", "INTERACTION_NOT_RESUMABLE");
  if (interaction.uid !== uid)
    return deny(bundle, request, response, "INTERACTION_MISMATCH");

  // (2) The decision, as the control plane recorded it.
  const consent = await bundle.consents.read(uid);
  if (operator && consent !== null && consent.decision !== "denied") {
    const approved =
      digest !== null &&
      (await bundle.consents.resumeSecretMatches(uid, digest));
    if (!approved)
      return plainPage(response, "refused", "RESUME_SECRET_REQUIRED");
  }
  if (
    consent === null ||
    consent.decision !== "approved" ||
    consent.resumedAt !== null ||
    consent.connectionId === null ||
    consent.humanAccountId === null ||
    consent.grantedGeneration === null ||
    Date.parse(consent.expiresAt) <= Date.now()
  )
    return deny(bundle, request, response, "CONSENT_NOT_GRANTED");

  // What the human was shown must be what this provider is about to grant.
  // Both sides read the frozen row rather than the live request, so a request
  // that changed underneath the review page cannot be approved by it.
  if (
    consent.oauthClientId !== (interaction.params.client_id ?? "") ||
    consent.preset !== preset ||
    (operator && consent.resource !== bundle.config.resource)
  )
    return deny(bundle, request, response, "CONSENT_DOES_NOT_MATCH_REQUEST");

  const capabilities = [...consent.capabilityScopes].sort();
  // The milestone gate, again, at the last place it can still refuse. An
  // approval that reached here asking for management was already refused by
  // the Admin and by a CHECK constraint; this is the layer that would catch a
  // consent row somehow written past both.
  if (capabilities.length !== 1 || capabilities[0] !== capability)
    return deny(bundle, request, response, "SCOPE_NOT_AVAILABLE");

  const scopes = [...capabilities, ...consent.protocolScopes];

  // (3) The connection must still be where the decision left it.
  const stored = await bundle.connections.read(consent.connectionId);
  if (
    stored === null ||
    stored.connection.status !== "authorized" ||
    stored.connection.revokedAt !== null ||
    stored.connection.generation !== consent.grantedGeneration
  )
    return deny(bundle, request, response, "CONNECTION_MOVED");

  const grant = new bundle.provider.Grant({
    accountId: consent.humanAccountId,
    clientId: consent.oauthClientId,
  });
  // Both, and the measurement is why. The provider declares the capability
  // scopes in its top-level `scopes`, so it checks them as OIDC scopes on the
  // way back: a grant carrying only the RESOURCE scope resumes into a second
  // consent prompt with `op_scopes_missing: ["artvenn:read"]` and the browser
  // bounces back to the Admin forever. Probed on the running service, r15.
  for (const scope of scopes) grant.addOIDCScope(scope);
  for (const scope of capabilities)
    grant.addResourceScope(consent.resource, scope);
  // The library accepts `openid` whatever we advertise, so a client that asks
  // for it anyway would bounce the same way. It is not recorded on the snapshot
  // below because it gains nothing: the door reads the frozen row, not this.
  if (operator) grant.addOIDCScope("openid");
  const grantId = await grant.save();

  // The immutable snapshot, with the generation the CONSENT froze.
  await bundle.connections.createGrant({
    grantId,
    connectionId: consent.connectionId,
    generationAtConsent: consent.grantedGeneration,
    oauthClientId: consent.oauthClientId,
    humanSubject: consent.humanAccountId,
    issuer: bundle.config.issuer,
    resource: consent.resource,
    capabilityScopes: capabilities,
    protocolScopes: [...consent.protocolScopes],
    presetAtConsent: preset,
  });

  // Conditional on that same generation. If the connection moved between the
  // read above and here, nothing is pointed anywhere: the grant exists but is
  // unreachable, and no token can be minted against a connection that does not
  // name it. Refusing late is still refusing.
  const pointed = await bundle.connections.setCurrentGrant(
    consent.connectionId,
    grantId,
    consent.grantedGeneration,
  );
  if (!pointed) return deny(bundle, request, response, "CONNECTION_MOVED");

  // Spent, exactly once. The trigger refuses a second resume even if two
  // browsers arrive together, so this is a check and a record rather than a
  // race this code has to win.
  const spent = await bundle.consents.resume({
    interactionUid: uid,
    grantId,
    resumeSecretDigest: digest,
  });
  if (spent === null) return deny(bundle, request, response, "CONSENT_SPENT");

  await bundle.provider.interactionFinished(
    request,
    response,
    {
      login: { accountId: consent.humanAccountId },
      consent: { grantId },
    },
    { mergeWithLastSubmission: false },
  );
  return { handled: true, code: `GRANTED:${scopes.length}` };
};
