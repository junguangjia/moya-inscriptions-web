import pg from "pg";
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
      `agent authorization is composed only in development with ${AUTHORIZATION_ENABLED_SETTING}=true or ARTICLE_AUTHORING_ENABLED=true\n`,
    );
    process.exitCode = 78;
    return;
  }
  const pools: pg.Pool[] = [];
  const listeners: { close: () => Promise<void> }[] = [];
  const close = async () => {
    await Promise.allSettled(listeners.map((server) => server.close()));
    await Promise.allSettled(pools.map((pool) => pool.end()));
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
    if (articleConfig !== null) {
      const pool = new pg.Pool({ connectionString: articleConfig.databaseUrl });
      pools.push(pool);
      listeners.push(
        await startArticleAuthorizationServer({
          config: articleConfig,
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
  process.exitCode = 78;
});
