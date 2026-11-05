import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresAnalyticsAdapter,
  PostgresAnalyticsInsights,
} from "@moya/community-postgres";
import { MappedStorageUrlResolver } from "@moya/image";

// The real Backend's analytics routes on the real App role, in a process of its own so
// its work is not on the driver's clock, for `run.mjs analytics`. Only what those routes
// need is composed, as in tests/cms/admin-mcp-analytics.test.ts.

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error("BENCH_BACKEND_ENVIRONMENT_REQUIRED");
  return value;
};

const pool = createPostgresPool(
  parsePostgresConfig({
    DATABASE_URL: env("ADMIN_MCP_BENCH_BACKEND_DATABASE"),
  }),
);
const backend = createBackendServer(
  createBackendApplication({
    nodeEnv: "development",
    storageUrlResolver: new MappedStorageUrlResolver(new Map()),
    // The operator routes hang off the community group. No analytics route reads this.
    communityIdentityPort: {} as never,
    communityOperatorCredential: "",
    operatorAiBaseCredential: env("ADMIN_MCP_BENCH_BASE_TOKEN"),
    analytics: {
      port: new PostgresAnalyticsAdapter(pool),
      policy: {
        enabled: false,
        production: false,
        excludedUserIds: new Set(),
        ownerExclusionConfigured: false,
        hmacKey: "",
        forwardingConfigured: false,
        eventRetentionDays: 180,
      },
      insights: new PostgresAnalyticsInsights(pool, { retentionDays: 180 }),
    },
  }),
);
await startServer(backend, {
  host: "127.0.0.1",
  port: Number(env("ADMIN_MCP_BENCH_BACKEND_PORT")),
});

const stop = () => {
  void stopServer(backend)
    .then(() => pool.end())
    .finally(() => process.exit(0));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
