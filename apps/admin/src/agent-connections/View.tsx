import { DefaultTemplate } from "@payloadcms/next/templates";
import { redirect } from "next/navigation";
import type { AdminViewServerProps, PayloadRequest } from "payload";

import { isHumanOwner } from "../editorial/access";
import {
  AgentConnectionsClient,
  ConnectionsStepNav,
} from "./connections-client";
import { AgentConsentClient } from "./consent-client";
import {
  ConsentError,
  consentReviewPath,
  describeConsent,
  interactionUidSchema,
  mintConsentTicket,
} from "./consent";
import { oauthSurfaceEnabled, servedPreset } from "./composition";
import { OperatorConnectionsClient } from "./operator-connections-client";
import { resolveConnection } from "./resolve";
import { consentRuntime } from "./runtime";

import styles from "./connections.module.css";

/**
 * Agent Connections V1 (Issue #141 r15 §5, §9) and the login door (amendment
 * 2026-11-05) — the two views reserved to an Owner browser session.
 *
 * `AgentConsentView` is the REVIEW page: the second half of the two-step the
 * measured cookie behaviour forces. The landing outside `/admin` authenticated
 * nobody; this page does, because the browser sends the `SameSite=Strict` session
 * on a same-origin step, a link or the landing's meta refresh alike (measured on
 * Chromium and WebKit, the record's section 22).
 *
 * Payload skips the login redirect for custom views, so these views do their own.
 * A browser with no session goes to the login page and comes back here. A request
 * that carries an `Authorization` header is no browser with no session: it stays
 * refused, whatever the header held, because the login page is not for a key or a
 * connection token.
 *
 * Arming happens HERE, on the server, during the render that the Owner's
 * session authenticated, and from the row the PROVIDER wrote rather than from
 * anything the request supplied.
 *
 * Be exact about what that is: it IS a write during a GET page render. What makes
 * it safe is not the method but the gates above it. The Owner browser session is
 * checked first. Under the Development read-only profile the landing waits for a
 * click, and a cross-site navigation carries no `SameSite=Strict` session, so
 * nothing started elsewhere arms anything. Under `operator` that is not so: the
 * landing's refresh is a same-origin step, so a link or popup started elsewhere CAN
 * arm a ticket in a signed-in owner's session. What keeps that harmless is what the
 * ticket is for: it is rendered only into this same-origin page, which no other site
 * can read; spending it takes a click here, the ticket, a same-origin `Origin` and
 * the Strict cookie on the POST; and the issuer resumes only with the one-time secret
 * that POST returned, beside its own cookie in the browser that started the request.
 * 允许 also waits a moment after the page is shown. Nothing prefetches this page
 * either: the landing's link is a plain `<a>`, and the workspace tabs prefetch
 * nothing.
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
 * SO WHAT DOES A SECOND RENDER COST? `resolveConnection` is read-then-create, and
 * the duplicate that once produced is closed underneath this page, in the store
 * and in migration 20260921010000. What is left is exactly one thing: the ticket
 * rendered into the FIRST page is dead. An older tab is the case that loses, and it
 * loses recoverably, pinned in `agent-connection-consent-cases.ts` under the name
 * "re-arms an undecided interaction, which kills the ticket it replaced": `decide`
 * matches no row, the page refuses with CONSENT_NOT_DECIDABLE, and reloading arms a
 * fresh ticket because the interaction is still undecided. A refusal, not a wedge,
 * and not a second connection.
 */

/**
 * Said on both views. A plain sentence for someone who may never have seen the word
 * "Owner": the role is called 管理员 everywhere else they look.
 */
const OWNER_ONLY_SENTENCE = "只有管理员账号可以使用这一页。";

/**
 * No session, and no credential of another kind either. An expired cookie reads
 * as this too, and signing in is the right answer to it.
 */
const signedOut = (req: PayloadRequest): boolean =>
  (req.user === null || req.user === undefined) &&
  !req.headers.has("authorization");

/** The path comes from this server, and the login form checks it again. */
const loginWithReturn = (path: string): string =>
  `/admin/login?redirect=${encodeURIComponent(path)}`;

const Shell = ({
  children,
  props,
  stepNav,
}: {
  readonly children: React.ReactNode;
  readonly props: AdminViewServerProps;
  /**
   * Rendered on every branch inside the template. A breadcrumb belongs to the
   * route, not to whether a feature is on, and that branch is precisely where a
   * leaked one would sit under a page that never mounted its own client.
   */
  readonly stepNav?: React.ReactNode;
}) => {
  const { req, visibleEntities } = props.initPageResult;
  // Outside the template, which keeps its first column for a nav only an owner
  // gets. Without one, this sentence stood one character wide at phone width.
  if (!isHumanOwner(req))
    return (
      <main className={styles.landing}>
        <p className={styles.consentText} role="alert">
          {OWNER_ONLY_SENTENCE}
        </p>
      </main>
    );
  return (
    <DefaultTemplate {...props} req={req} visibleEntities={visibleEntities}>
      {stepNav}
      <div className="archive-view">{children}</div>
    </DefaultTemplate>
  );
};

/** One plain sentence, with the code small enough to read out to someone. */
const Refused = ({ code }: { readonly code: string }) => (
  <section className={styles.consent} data-agent-consent-refused={code}>
    <h1 className={styles.consentTitle}>这次连接没有完成</h1>
    <p className={styles.consentText} role="alert">
      请回到工具重新点连接。
    </p>
    <small className={styles.code}>{code}</small>
  </section>
);

/**
 * Back or a refresh after this same person decided. The refusal above would tell
 * them a connection that worked had failed. Only the person who decided sees this,
 * so to anyone else a spent interaction still reads as one nobody opened.
 */
const AlreadyDecided = () => (
  <section className={styles.consent} data-agent-consent-decided>
    <h1 className={styles.consentTitle}>这次请求已经处理过了</h1>
    <p className={styles.consentText} role="status">
      是否已连上，请到
      <a className={styles.quietLink} href="/admin/agent-connections">
        「AI 连接」
      </a>
      页查看。
    </p>
  </section>
);

const firstParam = (
  value: string | string[] | undefined,
): string | undefined => (Array.isArray(value) ? value[0] : value);

/**
 * The address a tool connects to, from this deployment's own public address and
 * never from a request. Null only where that setting is absent, which Production's
 * settings check refuses; the page then shows the resource the list reports.
 */
const toolAddress = (): string | null => {
  const base = process.env.CMS_PUBLIC_URL;
  return base && URL.canParse(base) ? new URL("/api/mcp", base).href : null;
};

export const AgentConnectionsView = (props: AdminViewServerProps) => {
  if (oauthSurfaceEnabled() && signedOut(props.initPageResult.req))
    redirect(loginWithReturn("/admin/agent-connections"));
  return (
    // The breadcrumb is client state the last view to mount owns, so a branch
    // that mounts no connections UI would otherwise show whichever page the
    // reader came from. Set here, on every branch of this route; the enabled
    // branch's client sets the same label again on mount, which is the same
    // value and therefore not a second answer.
    <Shell props={props} stepNav={<ConnectionsStepNav />}>
      {!oauthSurfaceEnabled() ? (
        <p role="alert">AI 连接未启用。</p>
      ) : servedPreset() === "operator" ? (
        <OperatorConnectionsClient address={toolAddress()} />
      ) : (
        <AgentConnectionsClient />
      )}
    </Shell>
  );
};

export const AgentConsentView = async (props: AdminViewServerProps) => {
  // Before anything that catches: `redirect` works by throwing.
  const interaction = interactionUidSchema.safeParse(
    firstParam(props.searchParams?.interaction),
  );
  if (
    oauthSurfaceEnabled() &&
    interaction.success &&
    signedOut(props.initPageResult.req)
  )
    redirect(loginWithReturn(consentReviewPath(interaction.data)));
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
  if (!isHumanOwner(req)) return null;

  const interaction = firstParam(props.searchParams?.interaction);
  if (interaction === undefined) return <Refused code="INTERACTION_REQUIRED" />;

  const userId = req.user?.id;
  if (typeof userId !== "string" && typeof userId !== "number")
    return <Refused code="OWNER_ONLY" />;
  const humanAccountId = `payload-user-${String(userId)}`;

  try {
    // Inside the try: a runtime that refused to build throws, and the person
    // reading this still gets a sentence.
    const runtime = consentRuntime();
    if (runtime === null) return <Refused code="NOT_ENABLED" />;
    const consent = await runtime.consents.read(interaction);
    // A uid nobody opened, or one already decided, reveals nothing beyond
    // "not available": a prober must not be able to tell a live interaction
    // from a spent one. Under `operator` the person who decided it is told it
    // was handled; the Development read-only profile stays as #141 measured it.
    if (consent !== null && consent.decision !== null)
      return runtime.preset === "operator" &&
        consent.humanAccountId === humanAccountId ? (
        <AlreadyDecided />
      ) : (
        <Refused code="INTERACTION_NOT_AVAILABLE" />
      );
    if (consent === null) return <Refused code="INTERACTION_NOT_AVAILABLE" />;

    const display = describeConsent({
      interactionUid: consent.interactionUid,
      oauthClientId: consent.oauthClientId,
      resource: consent.resource,
      capabilityScopes: consent.capabilityScopes,
      protocolScopes: consent.protocolScopes,
      preset: consent.preset,
      servedPreset: runtime.preset,
      registered: runtime.clients.get(consent.oauthClientId),
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

    return (
      <AgentConsentClient
        display={display}
        person={req.user?.collection === "users" ? req.user.email : ""}
        ticket={ticket}
      />
    );
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
