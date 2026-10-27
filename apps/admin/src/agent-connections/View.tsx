import { DefaultTemplate } from "@payloadcms/next/templates";
import type { AdminViewServerProps } from "payload";

import { isOwner } from "../editorial/access";
import {
  AgentConnectionsClient,
  ConnectionsStepNav,
} from "./connections-client";
import { AgentConsentClient } from "./consent-client";
import { ConsentError, describeConsent, mintConsentTicket } from "./consent";
import { connectionsEnabled } from "./composition";
import { resolveConnection } from "./resolve";
import { consentRuntime } from "./runtime";

/**
 * Agent Connections V1 (Issue #141 r15 §5, §9) — the two Owner-only views.
 *
 * `AgentConsentView` is the REVIEW page: the second half of the two-step the
 * measured cookie behaviour forces. The landing outside `/admin` authenticated
 * nobody; this page does, because the human took a same-origin step of their
 * own and the browser sent the `SameSite=Strict` session with it.
 *
 * Arming happens HERE, on the server, during the render that the Owner's
 * session authenticated, and from the row the PROVIDER wrote rather than from
 * anything the request supplied.
 *
 * Be exact about what that is: it IS a write during a GET page render, and a
 * prefetch of this link would perform it. An independent review was right that
 * an earlier version of this sentence said the opposite. What makes it safe is
 * not the method but the two gates above it — the Owner check precedes it, and
 * on the cross-site navigation the `SameSite=Strict` session is absent, so a
 * prefetch from anywhere but an authenticated Admin page arms nothing.
 *
 * RE-ARMING IS NOT IDEMPOTENT, and an earlier version of this paragraph called
 * it that. The store says what it actually is, in as many words: re-arming is
 * "deliberately allowed and deliberately destructive", because reloading this
 * page mints a FRESH ticket and kills the previous one. Repeating the same SQL
 * input would be idempotent; a render that produces NEW input is not. What is
 * true is narrower and is the part that matters: it cannot touch a decided or
 * expired interaction, because `decided_at IS NULL` and the live deadline are
 * in the WHERE clause.
 *
 * THAT REASONING IS ABOUT AUTHORIZATION, AND IT MISSED A COST. The gates above
 * answer who may arm an interaction, and they still hold. None of them answers
 * what happens when this render runs TWICE for one navigation,
 * which a prefetch plus the real navigation does: `resolveConnection` was
 * read-then-create, so both renders read "no connection" and both opened one.
 * Measured on a disposable target, and reported once from the Owner
 * walkthrough — two rows for one (human, client) pair, and a pair with two
 * rows is a pair `findForClient` then refuses, so the next consent for it could
 * not succeed at all. The duplicate is closed underneath this page, in the
 * store and in migration 20260921010000, NOT here.
 *
 * SO WHAT DOES A SECOND RENDER COST, now that the connection cannot duplicate?
 * Exactly one thing: the ticket rendered into the FIRST page is dead. That is
 * survivable in the ordinary sequence and is already pinned, in
 * `agent-connection-consent-cases.ts` under the name "re-arms an undecided
 * interaction, which kills the ticket it replaced" — the second ticket decides,
 * the first is refused, and a decided interaction can never be re-armed at all.
 * A prefetch followed by the real navigation leaves the reader looking at the
 * LAST render, so the form in front of them is the live one. An older tab is
 * the case that loses, and it loses recoverably: `decide` matches no row, the
 * page refuses with CONSENT_NOT_DECIDABLE, and reloading arms a fresh ticket
 * because the interaction is still undecided. A refusal, not a wedge, and not
 * a second connection.
 *
 * ONE THING THAT IS NOT PROVEN EITHER WAY, recorded rather than claimed: the
 * two renders arm in whatever order they reach the database, and the order the
 * BROWSER paints them in is not that order. If the slower prefetch arms after
 * the navigation, the ticket in the form the reader is looking at is already
 * dead and their first click is refused — still recoverable by reloading, but
 * a refusal they did nothing to earn. A review raised it by reading; it has
 * NOT been reproduced, and nothing here is built on the assumption that it
 * cannot happen. Closing it means deciding where arming belongs, which is the
 * open question below, not a line to add to a uniqueness guard.
 *
 * WHAT IS STILL OPEN, deliberately and separately: whether a GET render is the
 * right place for a write at all. The open question is the shape, not a known
 * defect. It is recorded rather than changed here, because moving arming out of
 * the render is a change to the consent flow's two-step — the thing the measured
 * cookie behaviour forced — and that deserves its own slice with its own
 * evidence rather than riding along with a uniqueness guard.
 */

const Shell = ({
  children,
  props,
  stepNav,
}: {
  readonly children: React.ReactNode;
  readonly props: AdminViewServerProps;
  /**
   * Rendered on EVERY branch, including the refusal. A breadcrumb belongs to
   * the route, not to whether the reader is allowed to see what is on it —
   * and the refusal branch is precisely where a leaked one would sit under a
   * page that never mounted its own client.
   */
  readonly stepNav?: React.ReactNode;
}) => {
  const { req, visibleEntities } = props.initPageResult;
  return (
    <DefaultTemplate {...props} req={req} visibleEntities={visibleEntities}>
      {stepNav}
      <div className="archive-view">
        {isOwner(req) ? children : <p role="alert">此工作区仅限 Owner。</p>}
      </div>
    </DefaultTemplate>
  );
};

/** A refusal that names a code and nothing else. */
const Refused = ({ code }: { readonly code: string }) => (
  <section data-agent-consent-refused={code}>
    <h2>无法确认这次授权</h2>
    <p role="alert">{code}</p>
    <p>请回到应用重新发起连接。</p>
  </section>
);

const firstParam = (
  value: string | string[] | undefined,
): string | undefined => (Array.isArray(value) ? value[0] : value);

export const AgentConnectionsView = (props: AdminViewServerProps) => (
  // The breadcrumb is client state the last view to mount owns, so a branch
  // that mounts no connections UI would otherwise show whichever page the
  // reader came from. Set here, on every branch of this route; the enabled
  // branch's client sets the same label again on mount, which is the same
  // value and therefore not a second answer.
  <Shell props={props} stepNav={<ConnectionsStepNav />}>
    {connectionsEnabled() ? (
      <AgentConnectionsClient />
    ) : (
      <p role="alert">AI 连接未启用。</p>
    )}
  </Shell>
);

export const AgentConsentView = async (props: AdminViewServerProps) => {
  const body = await consentBody(props);
  return <Shell props={props}>{body}</Shell>;
};

/**
 * Everything the review does before it renders anything. Kept out of the
 * component so each refusal is one `return`, and so the arming write happens
 * exactly once per render rather than once per React pass.
 */
const consentBody = async (
  props: AdminViewServerProps,
): Promise<React.ReactNode> => {
  const { req } = props.initPageResult;
  // The Owner check is repeated here rather than left to the shell: the shell
  // decides what is DISPLAYED, and this decides what is WRITTEN. A view that
  // armed an interaction before its wrapper refused to show it would have
  // bound a consent to somebody the page never let in.
  if (!isOwner(req)) return null;
  const runtime = consentRuntime();
  if (runtime === null) return <Refused code="NOT_ENABLED" />;

  const interaction = firstParam(props.searchParams?.interaction);
  if (interaction === undefined) return <Refused code="INTERACTION_REQUIRED" />;

  const userId = req.user?.id;
  if (typeof userId !== "string" && typeof userId !== "number")
    return <Refused code="OWNER_ONLY" />;
  const humanAccountId = `payload-user-${String(userId)}`;

  try {
    const consent = await runtime.consents.read(interaction);
    // A uid nobody opened, or one already decided, reveals nothing beyond
    // "not available": a prober must not be able to tell a live interaction
    // from a spent one.
    if (consent === null || consent.decision !== null)
      return <Refused code="INTERACTION_NOT_AVAILABLE" />;

    const display = describeConsent({
      interactionUid: consent.interactionUid,
      oauthClientId: consent.oauthClientId,
      resource: consent.resource,
      capabilityScopes: consent.capabilityScopes,
      protocolScopes: consent.protocolScopes,
      preset: consent.preset,
      expiresAt: consent.expiresAt,
      environment: runtime.environment,
      now: new Date(),
    });
    // The resource the human is about to be shown must be the one this Admin
    // is the resource server for. Refused, never rewritten to agree.
    if (display.resource !== runtime.resource)
      return <Refused code="RESOURCE_NOT_AVAILABLE" />;

    const connection = await resolveConnection(
      runtime,
      humanAccountId,
      display.client,
    );
    const { ticket, digest } = mintConsentTicket();
    const armed = await runtime.consents.arm({
      interactionUid: display.interaction,
      ticketDigest: digest,
      connectionId: connection.id,
      humanAccountId,
    });
    if (armed === null) return <Refused code="INTERACTION_NOT_AVAILABLE" />;

    return <AgentConsentClient display={display} ticket={ticket} />;
  } catch (error) {
    return (
      <Refused
        code={
          error instanceof ConsentError ? error.code : "CONSENT_UNAVAILABLE"
        }
      />
    );
  }
};
