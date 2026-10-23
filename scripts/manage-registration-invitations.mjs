import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL, URL } from "node:url";
import process from "node:process";
import console from "node:console";

const refuse = () => {
  throw new Error("REGISTRATION_INVITATION_OPERATION_REFUSED");
};
const positiveInteger = (value, maximum) => {
  if (!/^[1-9][0-9]*$/u.test(value ?? "")) refuse();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) refuse();
  return number;
};
export const registrationInvitationDigest = (code) =>
  createHash("sha256")
    .update(`artvenn:registration-invitation:v1:${code.trim()}`, "utf8")
    .digest("hex");

export function parseInvitationCommand(args) {
  const [action, ...rest] = args;
  if (
    !["create", "status", "revoke", "revoke-access", "restore-access"].includes(
      action,
    )
  )
    refuse();
  const flags = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index],
      value = rest[index + 1];
    if (!flag?.startsWith("--") || !value || flags[flag] !== undefined)
      refuse();
    flags[flag] = value;
  }
  const permitted =
    action === "create"
      ? ["--max-uses", "--expires-in-days", "--output-file"]
      : action === "status" || action === "revoke"
        ? ["--id"]
        : ["--user-id"];
  if (Object.keys(flags).some((flag) => !permitted.includes(flag))) refuse();
  if (action === "create") {
    if (!isAbsolute(flags["--output-file"] ?? "")) refuse();
    return {
      action,
      maxUses: positiveInteger(flags["--max-uses"] ?? "20", 10000),
      expiresInDays: positiveInteger(flags["--expires-in-days"] ?? "7", 365),
      outputFile: flags["--output-file"],
    };
  }
  if (action === "status" && flags["--id"] === undefined) return { action };
  const id =
    flags[action === "status" || action === "revoke" ? "--id" : "--user-id"];
  const pattern =
    action === "status" || action === "revoke"
      ? /^invitation-[0-9a-f]{32}$/u
      : /^user-[0-9a-f]{32}$/u;
  if (!pattern.test(id ?? "")) refuse();
  return { action, id };
}

/** Offline operator boundary. No runtime connection/configuration fallback. */
export async function manageRegistrationInvitations(
  pool,
  command,
  environment,
) {
  if (!["development", "production"].includes(environment)) refuse();
  const client = await pool.connect();
  let output;
  let createdOutput = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='15s'");
    const writes = await client.query(`SELECT
      has_table_privilege(current_user,'community.registration_invitations','INSERT') AND
      has_table_privilege(current_user,'community.registration_invitations','UPDATE') AND
      has_table_privilege(current_user,'community.beta_account_access','INSERT') AND
      has_table_privilege(current_user,'community.beta_account_access','UPDATE') AS allowed`);
    if (writes.rows[0]?.allowed !== true) refuse();
    let result;
    if (command.action === "create") {
      output = await open(
        command.outputFile,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      createdOutput = true;
      const stat = await output.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.()
      )
        refuse();
      const code = randomBytes(16).toString("base64url");
      const id = `invitation-${randomBytes(16).toString("hex")}`;
      const inserted = await client.query(
        `INSERT INTO community.registration_invitations
        (id,digest,environment,max_uses,expires_at) VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+($5::integer*INTERVAL '1 day'))
        RETURNING id,max_uses,used_count,created_at,expires_at,revoked_at`,
        [
          id,
          registrationInvitationDigest(code),
          environment,
          command.maxUses,
          command.expiresInDays,
        ],
      );
      result = inserted.rows[0];
      await output.writeFile(
        JSON.stringify(
          {
            invitationId: id,
            invitationCode: code,
            maxUses: command.maxUses,
            expiresAt: result.expires_at,
          },
          null,
          2,
        ) + "\n",
      );
      await output.sync();
      await output.close();
      output = undefined;
    } else if (command.action === "status") {
      result = (
        await client.query(
          `SELECT id,environment,max_uses,used_count,created_at,expires_at,revoked_at
        FROM community.registration_invitations WHERE environment=$1 AND ($2::text IS NULL OR id=$2)
        ORDER BY created_at DESC,id`,
          [environment, command.id ?? null],
        )
      ).rows;
    } else if (command.action === "revoke") {
      const changed = await client.query(
        `UPDATE community.registration_invitations
        SET revoked_at=COALESCE(revoked_at,CURRENT_TIMESTAMP) WHERE id=$1 AND environment=$2 RETURNING id`,
        [command.id, environment],
      );
      if (changed.rowCount !== 1) refuse();
      result = { invitationId: command.id, state: "revoked" };
    } else {
      const state = command.action === "revoke-access" ? "revoked" : "granted";
      const changed = await client.query(
        `INSERT INTO community.beta_account_access(user_id,state)
        SELECT id,$2 FROM community.public_users WHERE id=$1
        ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state,updated_at=CURRENT_TIMESTAMP
        RETURNING user_id`,
        [command.id, state],
      );
      if (changed.rowCount !== 1) refuse();
      result = { userId: command.id, state };
    }
    await client.query("COMMIT");
    createdOutput = false;
    return result;
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    refuse();
  } finally {
    await output?.close().catch(() => undefined);
    if (createdOutput) await unlink(command.outputFile).catch(() => undefined);
    client.release();
  }
}

export async function invitationDatabaseConfiguration(environment) {
  const { parsePostgresConfig } =
    await import("../services/catalog-postgres/dist/index.js");
  if (environment.NODE_ENV === "production") {
    let url;
    try {
      url = new URL(environment.APP_INVITATION_DATABASE_URL);
    } catch {
      refuse();
    }
    if (url.searchParams.getAll("sslmode").join(",") !== "verify-full")
      refuse();
  }
  return parsePostgresConfig({
    DATABASE_URL: environment.APP_INVITATION_DATABASE_URL,
    DATABASE_SSL_CA_FILE: environment.APP_INVITATION_DATABASE_SSL_CA_FILE,
  });
}
export async function runInvitationCommand(
  environment = process.env,
  args = process.argv.slice(2),
) {
  const command = parseInvitationCommand(args);
  if (!["development", "production"].includes(environment.NODE_ENV)) refuse();
  const config = await invitationDatabaseConfiguration(environment);
  const { createPostgresPool } =
    await import("../services/catalog-postgres/dist/index.js");
  const pool = createPostgresPool(config);
  try {
    return await manageRegistrationInvitations(
      pool,
      command,
      environment.NODE_ENV,
    );
  } finally {
    await pool.end();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.info(JSON.stringify(await runInvitationCommand()));
  } catch {
    console.error("REGISTRATION_INVITATION_OPERATION_REFUSED");
    process.exitCode = 1;
  }
}
