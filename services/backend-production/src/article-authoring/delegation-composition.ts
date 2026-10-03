import {
  createArticleConsentStore,
  createArticleDelegationStore,
  admitArticleOAuthGrant,
} from "@moya/community-postgres";
import type {
  ArticleDelegationAuthority,
  WrapperStore,
  PostgresArticleAuthoringOptions,
} from "@moya/community-postgres";
import type { createPostgresPool } from "@moya/catalog-postgres";
import type { ArticleMcpDependencies } from "@moya/backend-runtime";
import type { ArticleDelegationRuntime } from "@moya/backend-runtime";
import { createArticleMcpHandler } from "@moya/backend-runtime";

type Pool = ReturnType<typeof createPostgresPool>;
type PoolClient = Parameters<
  NonNullable<PostgresArticleAuthoringOptions["assertDelegatedActor"]>
>[0];
type Delegated = Awaited<ReturnType<ArticleMcpDependencies["admit"]>>;
type ArticleAuthoringService = ArticleMcpDependencies["authoring"];
/** First build these guards; inject them into the same Postgres Article adapter. */
export const createArticleDelegationPersistence = (
  controlPool: Pool,
  authority: ArticleDelegationAuthority,
  options: { readonly readPool: Pool; readonly clock?: () => Date },
) => {
  const connections = createArticleDelegationStore(
    controlPool,
    authority,
    options,
  );
  const consents = createArticleConsentStore(controlPool, authority, options);
  return {
    connections,
    consents,
    adapterOptions: {
      assertDelegatedActor: connections.assertActor,
      assertDelegatedPublication: connections.assertPublication,
    },
  };
};

/** No listener, pool, key, identity or service is created by this factory. */
export const createArticleDelegationRuntime = (options: {
  readonly nodeEnv: string;
  readonly enabled: boolean;
  readonly pool: Pool;
  readonly authority: ArticleDelegationAuthority;
  readonly wrappers: Pick<WrapperStore, "resolve">;
  readonly persistence: ReturnType<typeof createArticleDelegationPersistence>;
  readonly authoring: ArticleAuthoringService;
  readonly humanWebOrigin: string;
  readonly clients: ArticleDelegationRuntime["clients"];
  readonly readPublished: ArticleDelegationRuntime["readPublished"];
  readonly now?: () => Date;
  /** Reuse existing read adapters inside this transaction and actor fence. */
  readonly discoverCatalog: (
    db: PoolClient,
    actor: Delegated,
    query: Parameters<ArticleMcpDependencies["discoverCatalog"]>[1],
  ) => ReturnType<ArticleMcpDependencies["discoverCatalog"]>;
  readonly readCatalog: (
    db: PoolClient,
    actor: Delegated,
    id: Parameters<ArticleMcpDependencies["readCatalog"]>[1],
  ) => ReturnType<ArticleMcpDependencies["readCatalog"]>;
  readonly inspectThumbnail: (
    db: PoolClient,
    actor: Delegated,
    itemId: string,
  ) => ReturnType<ArticleMcpDependencies["inspectThumbnail"]>;
}) => {
  if (
    !options.enabled ||
    !["development", "production"].includes(options.nodeEnv)
  )
    return undefined;
  if (options.authority.environment !== options.nodeEnv)
    throw new Error("Article authority environment must match its runtime");
  const now = options.now ?? (() => new Date());
  const { connections, consents } = options.persistence;
  const admitted = async <T>(
    actor: Delegated,
    run: (db: PoolClient) => Promise<T>,
  ): Promise<T> => {
    const db = await options.pool.connect();
    try {
      await db.query("BEGIN");
      await connections.assertActor(db, actor, "read", null, now());
      const result = await run(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      db.release();
    }
  };
  const human: ArticleDelegationRuntime = {
    connections,
    consents,
    authoring: options.authoring,
    readPublished: options.readPublished,
    issuer: options.authority.issuer,
    clients: options.clients,
  };
  const mcp = createArticleMcpHandler({
    ...options.authority,
    authoring: options.authoring,
    humanWebOrigin: options.humanWebOrigin,
    admit: (presented) =>
      admitArticleOAuthGrant({
        presented,
        wrappers: options.wrappers,
        pool: options.pool,
        authority: options.authority,
        now: now(),
      }),
    assertCurrent: (actor) => admitted(actor, async () => undefined),
    readApproval: (actor, input) =>
      connections.readApproval(
        actor,
        { ...input, connectionId: actor.connectionId },
        now(),
      ),
    discoverCatalog: (actor, query) =>
      admitted(actor, (db) => options.discoverCatalog(db, actor, query)),
    discoverMedia: (actor, query) =>
      options.authoring.listOwnMedia(actor, query),
    readCatalog: (actor, id) =>
      admitted(actor, (db) => options.readCatalog(db, actor, id)),
    inspectThumbnail: (actor, id) =>
      admitted(actor, (db) => options.inspectThumbnail(db, actor, id)),
  });
  return {
    human,
    mcp,
    resource: options.authority.resource,
    environment: options.authority.environment,
  };
};
