import { parsePostgresConfig } from "@moya/catalog-postgres";

import type { PostgresConfig } from "@moya/catalog-postgres";

/*
 * The Community App role connection of this package's two composition roots:
 * the Backend (`composition.ts`) and the media worker
 * (`worker-composition.ts`). The role is DML-only and is read at runtime by
 * nothing else. It lives in its own module so the worker parses it without
 * loading the Backend composition (HTTP application, sign-in, notifications).
 */

type Environment = Readonly<Record<string, string | undefined>>;

export const parseCommunityPostgresConfig = (
  environment: Environment,
): PostgresConfig => {
  const url = environment.APP_DATABASE_URL;
  if (url === undefined || url === "")
    throw new Error("APP_DATABASE_URL is required");
  try {
    return parsePostgresConfig({
      DATABASE_URL: url,
      DATABASE_SSL_CA_FILE: environment.APP_DATABASE_SSL_CA_FILE,
      DATABASE_POOL_MAX: environment.DATABASE_POOL_MAX,
      DATABASE_IDLE_TIMEOUT_MS: environment.DATABASE_IDLE_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message.replace(/\bDATABASE_URL\b/g, "APP_DATABASE_URL")
        : "APP_DATABASE_URL is invalid",
      { cause: error },
    );
  }
};
