import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  hashPassword,
  verifyPassword,
  validPassword,
} from "../services/api/dist/index.js";

const refuse = () => {
  throw new Error("OPERATOR_PASSWORD_SETUP_REFUSED");
};
export async function readPasswordAccountInput(path) {
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid?.() ||
      stat.size < 1 ||
      stat.size > 16384
    )
      refuse();
    const bytes = Buffer.alloc(16385);
    let used = 0;
    while (used < bytes.length) {
      const read = await file.read(bytes, used, bytes.length - used, null);
      if (read.bytesRead === 0) break;
      used += read.bytesRead;
    }
    if (used > 16384) refuse();
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)),
    );
  } catch {
    refuse();
  } finally {
    await file?.close();
  }
}
const fingerprint = (value) => createHash("sha256").update(value).digest("hex");
export function validatePasswordAccountInput(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !==
      "displayName,environment,handle,operatorLabel,password,requestId" ||
    typeof input.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      input.requestId,
    ) ||
    typeof input.handle !== "string" ||
    !/^[a-z][a-z0-9-]{2,31}$/u.test(input.handle) ||
    typeof input.displayName !== "string" ||
    input.displayName.trim() !== input.displayName ||
    [...input.displayName].length < 1 ||
    [...input.displayName].length > 40 ||
    /[\u0000\uD800-\uDFFF]/u.test(input.displayName) ||
    !["development", "production"].includes(input.environment) ||
    typeof input.operatorLabel !== "string" ||
    !/^[a-z][a-z0-9-]{2,63}$/u.test(input.operatorLabel) ||
    typeof input.password !== "string" ||
    !validPassword(input.password)
  )
    refuse();
  return input;
}
/** Offline operator boundary. Never imported by a running application. */
export async function provisionPasswordAccount(pool, raw) {
  const input = validatePasswordAccountInput(raw);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    // Runtime SELECT is insufficient, including a matching replay.
    const authority = await client.query(
      "SELECT has_table_privilege(current_user,'community.operator_password_accounts','INSERT') AS allowed",
    );
    if (authority.rows[0]?.allowed !== true) refuse();
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('operator-password-setup',0))",
    );
    const old = await client.query(
      `SELECT p.*,u.handle AS current_handle,u.display_name AS current_name,u.status,c.verifier,c.version
      FROM community.operator_password_accounts p JOIN community.public_users u ON u.id=p.user_id
      JOIN community.user_password_credentials c ON c.user_id=p.user_id
      WHERE p.request_id=$1 OR p.handle=$2 FOR UPDATE OF u,c`,
      [input.requestId, input.handle],
    );
    if (old.rows.length) {
      const row = old.rows[0];
      if (
        old.rows.length !== 1 ||
        row.request_id !== input.requestId ||
        row.handle !== input.handle ||
        row.current_handle !== input.handle ||
        row.display_name !== input.displayName ||
        row.current_name !== input.displayName ||
        row.environment !== input.environment ||
        row.operator_label !== input.operatorLabel ||
        row.status !== "active" ||
        row.version !== row.credential_version ||
        fingerprint(row.verifier) !== row.credential_fingerprint ||
        !(await verifyPassword(input.password, row.verifier))
      )
        refuse();
      await client.query("COMMIT");
      return { outcome: "existing", userId: row.user_id, handle: row.handle };
    }
    if (
      (
        await client.query(
          "SELECT id FROM community.public_users WHERE handle=$1",
          [input.handle],
        )
      ).rowCount !== 0
    )
      refuse();
    const userId = `user-${randomBytes(16).toString("hex")}`;
    const verifier = await hashPassword(input.password);
    const at = new Date().toISOString();
    await client.query(
      "INSERT INTO community.public_users(id,handle,display_name,status) VALUES($1,$2,$3,'active')",
      [userId, input.handle, input.displayName],
    );
    await client.query(
      "INSERT INTO community.user_password_credentials(user_id,verifier,version,updated_at) VALUES($1,$2,1,$3)",
      [userId, verifier, at],
    );
    await client.query(
      `INSERT INTO community.operator_password_accounts(request_id,user_id,handle,display_name,environment,operator_label,credential_version,credential_fingerprint)
      VALUES($1,$2,$3,$4,$5,$6,1,$7)`,
      [
        input.requestId,
        userId,
        input.handle,
        input.displayName,
        input.environment,
        input.operatorLabel,
        fingerprint(verifier),
      ],
    );
    await client.query(
      "INSERT INTO community.auth_audit_events(id,user_id,action,occurred_at) VALUES($1,$2,'operator_password_provision',$3)",
      [`auth-audit-${randomBytes(16).toString("hex")}`, userId, at],
    );
    await client.query("COMMIT");
    return { outcome: "created", userId, handle: input.handle };
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    refuse();
  } finally {
    client.release();
  }
}

export async function passwordAccountDatabaseConfiguration(environment) {
  const { parsePostgresConfig } =
    await import("../services/catalog-postgres/dist/index.js");
  if (environment.NODE_ENV === "production") {
    let url;
    try {
      url = new URL(environment.APP_PROVISION_DATABASE_URL);
    } catch {
      refuse();
    }
    if (url.searchParams.getAll("sslmode").join(",") !== "verify-full")
      refuse();
  }
  return parsePostgresConfig({
    DATABASE_URL: environment.APP_PROVISION_DATABASE_URL,
    DATABASE_SSL_CA_FILE: environment.APP_PROVISION_DATABASE_SSL_CA_FILE,
  });
}

export async function runPasswordAccountSetup(
  environment = process.env,
  args = process.argv.slice(2),
) {
  if (
    args.length !== 2 ||
    args[0] !== "--input" ||
    environment.AUTH_PROFILE !== "password-only" ||
    !["development", "production"].includes(environment.NODE_ENV)
  )
    refuse();
  const input = validatePasswordAccountInput(
    await readPasswordAccountInput(args[1]),
  );
  if (input.environment !== environment.NODE_ENV) refuse();
  const databaseConfig =
    await passwordAccountDatabaseConfiguration(environment);
  const { createPostgresPool } =
    await import("../services/catalog-postgres/dist/index.js");
  const pool = createPostgresPool(databaseConfig);
  try {
    return await provisionPasswordAccount(pool, input);
  } finally {
    await pool.end();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.info(JSON.stringify(await runPasswordAccountSetup()));
  } catch {
    console.error("OPERATOR_PASSWORD_SETUP_REFUSED");
    process.exitCode = 1;
  }
}
