import pg from "pg";
import { createPostgresPool } from "@moya/catalog-postgres";
import {
  articleAuthorizationPostgresFrom,
  prepareArticleAuthorizationKeys,
} from "./article-runtime-config.js";
import {
  AUTHORIZATION_ENABLED_SETTING,
  authorizationConfigFrom,
  authorizationEnabled,
} from "./config.js";
import { startAuthorizationServer } from "./server.js";
import { articleAuthorizationConfigFrom } from "./article-provider.js";
import { startArticleAuthorizationServer } from "./article-server.js";

/** Existing Admin config, pools and endpoints remain separately composed. */
const main = async (): Promise<void> => {
  const articleConfig = articleAuthorizationConfigFrom(process.env);
  const adminEnabled = authorizationEnabled();
  if (!adminEnabled && articleConfig === null) {
    process.stderr.write(
      `authorization requires an explicit enabled Article profile or Development ${AUTHORIZATION_ENABLED_SETTING}=true\n`,
    );
    process.exitCode = 78;
    return;
  }
  // Validate issuer keys and role/TLS configuration before any pool opens.
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
  const close = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 6_000);
    });
    await Promise.race([
      (async () => {
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
    if (adminEnabled) {
      const config = authorizationConfigFrom(process.env);
      const pool = new pg.Pool({ connectionString: config.databaseUrl });
      pools.push(pool);
      listeners.push(
        await startAuthorizationServer({
          config,
          pool,
          environment: process.env,
          buildId: process.env.AGENT_AUTHORIZATION_BUILD_ID ?? "unknown",
          recordFailure,
        }),
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
void main().catch(() => {
  process.stderr.write("agent authorization startup refused\n");
  process.exit(78);
});
