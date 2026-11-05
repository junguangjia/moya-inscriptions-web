import pg from "pg";
import { createPostgresPool } from "@moya/catalog-postgres";
import {
  articleAuthorizationPostgresFrom,
  prepareArticleAuthorizationKeys,
} from "./article-runtime-config.js";
import {
  adminAuthorizationPostgresFrom,
  prepareAdminAuthorizationKeys,
} from "./admin-runtime-config.js";
import {
  AUTHORIZATION_ENABLED_SETTING,
  AuthorizationConfigError,
  OPERATOR_ENABLED_SETTING,
  authorizationConfigFrom,
  authorizationEnabled,
} from "./config.js";
import { reapExpiredArtifacts, startArtifactReaper } from "./reaper.js";
import { startAuthorizationServer } from "./server.js";
import { articleAuthorizationConfigFrom } from "./article-provider.js";
import { startArticleAuthorizationServer } from "./article-server.js";

/** Existing Admin config, pools and endpoints remain separately composed. */
const main = async (): Promise<void> => {
  const articleConfig = articleAuthorizationConfigFrom(process.env);
  const adminEnabled = authorizationEnabled();
  if (!adminEnabled && articleConfig === null) {
    process.stderr.write(
      `authorization requires an explicit enabled Article profile, Development ${AUTHORIZATION_ENABLED_SETTING}=true or Production ${OPERATOR_ENABLED_SETTING}=true\n`,
    );
    process.exitCode = 78;
    return;
  }
  // Validate issuer keys and role/TLS configuration before any pool opens.
  const adminConfig = adminEnabled
    ? authorizationConfigFrom(process.env)
    : null;
  const adminOperator =
    adminConfig?.profile === "operator" ? adminConfig : null;
  const adminKeys =
    adminOperator === null
      ? undefined
      : prepareAdminAuthorizationKeys(adminOperator, process.env);
  const adminPostgres =
    adminOperator === null
      ? undefined
      : adminAuthorizationPostgresFrom(adminOperator, process.env);
  const articleKeys =
    articleConfig === null
      ? undefined
      : prepareArticleAuthorizationKeys(articleConfig, process.env);
  const articlePostgres =
    articleConfig === null
      ? undefined
      : articleAuthorizationPostgresFrom(articleConfig, process.env);
  const pools: pg.Pool[] = [];
  const listeners: { close: () => Promise<void> }[] = [];
  const reapers: (() => Promise<void>)[] = [];
  const close = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 6_000);
    });
    await Promise.race([
      (async () => {
        await Promise.allSettled(reapers.map((stop) => stop()));
        await Promise.allSettled(listeners.map((server) => server.close()));
        await Promise.allSettled(pools.map((pool) => pool.end()));
      })(),
      deadline,
    ]);
    if (timer !== undefined) clearTimeout(timer);
  };
  const recordFailure = (code: string) =>
    process.stderr.write(`authorization-failure ${code}\n`);
  try {
    if (adminConfig !== null) {
      const pool =
        adminPostgres === undefined
          ? new pg.Pool({ connectionString: adminConfig.databaseUrl })
          : createPostgresPool(adminPostgres, {
              onUnexpectedIdleError: () =>
                recordFailure("ADMIN_DATABASE_IDLE_ERROR"),
            });
      pools.push(pool);
      const server = await startAuthorizationServer({
        config: adminConfig,
        pool,
        environment: process.env,
        ...(adminKeys === undefined ? {} : { preparedKeys: adminKeys }),
        buildId: process.env.AGENT_AUTHORIZATION_BUILD_ID ?? "unknown",
        recordFailure,
      });
      listeners.push(server);
      if (adminOperator !== null)
        reapers.push(
          startArtifactReaper(
            () => reapExpiredArtifacts(server.bundle),
            recordFailure,
          ),
        );
    }
    if (
      articleConfig !== null &&
      articlePostgres !== undefined &&
      articleKeys !== undefined
    ) {
      const pool = createPostgresPool(articlePostgres, {
        onUnexpectedIdleError: () =>
          recordFailure("ARTICLE_DATABASE_IDLE_ERROR"),
      });
      pools.push(pool);
      listeners.push(
        await startArticleAuthorizationServer({
          config: articleConfig,
          preparedKeys: articleKeys,
          pool,
          environment: process.env,
          buildId: process.env.ARTICLE_AUTHORIZATION_BUILD_ID ?? "unknown",
          recordFailure,
        }),
      );
    }
  } catch {
    await close();
    throw new Error("AUTHORIZATION_STARTUP_REFUSED");
  }
  process.stdout.write("agent authorization listeners ready\n");
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
};
void main().catch((error: unknown) => {
  // The bare category when there is one, so a refused start can be told apart
  // from the outside. Never the message: a URL or a host may be in it.
  const code =
    error instanceof AuthorizationConfigError
      ? error.code
      : error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message)
        ? error.message
        : "";
  process.stderr.write(`agent authorization startup refused ${code}\n`);
  process.exit(78);
});
