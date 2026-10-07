import { describeProductAccess, loadProductAccess } from "./product-access.js";

/**
 * Validates the product access configuration the Backend would start with,
 * without starting it:
 *
 *   node services/backend-production/dist/access/check.js [--file <allowlist>] [--has <account id>]
 *
 * `--file` checks a candidate allowlist before it replaces the active one;
 * `--has` reports whether one account is admitted. It prints the mode and a
 * count, never the listed account ids.
 */
const main = (): void => {
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
  const policy = loadProductAccess(
    file === undefined
      ? process.env
      : {
          PRODUCT_ACCESS_MODE: "closed-beta",
          PRODUCT_ACCESS_ALLOWLIST_FILE: file,
        },
    process.env.NODE_ENV === "development" ? "development" : "production",
  );
  console.info(
    JSON.stringify({
      ...describeProductAccess(policy),
      ...(account === undefined ? {} : { admitted: policy.admits(account) }),
    }),
  );
};

try {
  main();
} catch (error) {
  console.error(
    `PRODUCT_ACCESS_REFUSED ${error instanceof Error ? error.message : "unknown"}`,
  );
  process.exitCode = 1;
}
