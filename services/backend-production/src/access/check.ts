import { describeProductAccess, loadProductAccess } from "./product-access.js";

/**
 * Validates the product access configuration the Backend would start with,
 * without starting it:
 *
 *   node services/backend-production/dist/access/check.js [--file <allowlist>] [--has <account id>]
 *
 * `--file` checks a candidate allowlist before it replaces the active one;
 * `--has` checks final admission using the runtime database. With `--file`,
 * it reports only candidate-file membership, explicitly labelled `listed`.
 * It prints the mode and a count, never the listed account ids.
 */
const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  let file: string | undefined;
  let account: string | undefined;
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (value === undefined || (flag !== "--file" && flag !== "--has"))
      throw new Error("Usage: check [--file <allowlist>] [--has <account id>]");
    if (flag === "--file") file = value;
    else account = value;
  }
  const environment =
    file === undefined
      ? process.env
      : {
          PRODUCT_ACCESS_MODE: "closed-beta",
          PRODUCT_ACCESS_ALLOWLIST_FILE: file,
        };
  const nodeEnv =
    process.env.NODE_ENV === "development" ? "development" : "production";
  let policy = loadProductAccess(environment, nodeEnv);
  let closeDatabase: (() => Promise<void>) | undefined;
  try {
    if (
      file === undefined &&
      account !== undefined &&
      policy.mode === "closed_beta"
    ) {
      // File/configuration checks must not load the database application graph.
      const [
        { closePostgresPool, createPostgresPool },
        { createPostgresBetaAccountAccess, verifyCommunityMigrationLedger },
        { parseCommunityPostgresConfig },
      ] = await Promise.all([
        import("@moya/catalog-postgres"),
        import("@moya/community-postgres"),
        import("../community-postgres-config.js"),
      ]);
      const pool = createPostgresPool(
        parseCommunityPostgresConfig(process.env),
      );
      closeDatabase = () => closePostgresPool(pool);
      await verifyCommunityMigrationLedger(pool);
      policy = loadProductAccess(environment, nodeEnv, {
        betaAccountAccess: createPostgresBetaAccountAccess(pool),
      });
    }
    console.info(
      JSON.stringify({
        ...describeProductAccess(policy),
        evaluation:
          file !== undefined
            ? "candidate-file"
            : account !== undefined
              ? "runtime-account"
              : "configuration",
        ...(account === undefined
          ? {}
          : file !== undefined
            ? { listed: await policy.admits(account) }
            : { admitted: await policy.admits(account) }),
      }),
    );
  } finally {
    await closeDatabase?.();
  }
};

void main().catch((error: unknown) => {
  console.error(
    `PRODUCT_ACCESS_REFUSED ${error instanceof Error ? error.message : "unknown"}`,
  );
  process.exitCode = 1;
});
