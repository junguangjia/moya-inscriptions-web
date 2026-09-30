import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  CommunityAuthService,
  assertProductionAuthConfiguration,
  createDevelopmentAuthService,
} from "@moya/api";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresCommunityAuthAdapter,
  requiredCommunityMigrations,
  runCommunityMigrations,
  verifyCommunityMigrationLedger,
} from "@moya/community-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  passwordAuthCases,
  registerPasswordCase,
  preparePasswordResetCase,
} from "../../unit/backend/password-auth-cases";

import {
  assertSyntheticTestDatabaseUrl,
  requireSyntheticTestDatabaseUrl,
} from "./synthetic-test-database.js";

import type { AuthDeliveryPorts } from "@moya/api";

type Pool = ReturnType<typeof createPostgresPool>;

const sharedUrl = requireSyntheticTestDatabaseUrl();
const dedicatedName = `email_auth_${randomBytes(6).toString("hex")}_synthetic_test`;
const ownerUrl = (() => {
  const url = new URL(sharedUrl);
  url.pathname = `/${dedicatedName}`;
  url.search = "";
  url.hash = "";
  assertSyntheticTestDatabaseUrl(url.toString());
  return url.toString();
})();
const root = fileURLToPath(new URL("../../../", import.meta.url));
const migrationsDirectory = path.join(root, "database", "community-migrations");
const baselineMigrationId = "20260921010000";
const authMigrationId = "20260922010000";
const keys = {
  version: 1,
  lookupKey: Buffer.alloc(32, 11),
  encryptionKey: Buffer.alloc(32, 12),
  otpKey: Buffer.alloc(32, 13),
};
const codes: string[] = [];
const delivery = (): AuthDeliveryPorts => ({
  sendEmail: async (input) => {
    codes.push(input.code);
    return { state: "accepted", correlation: "pg-mail" };
  },
  sendPhone: async (input) => {
    if (input.code !== null) codes.push(input.code);
    return { state: "accepted", correlation: "pg-sms" };
  },
  checkPhone: async () => "fail",
});
const key = () => randomUUID();
const latest = () => {
  const code = codes.at(-1);
  if (code === undefined) throw new Error("missing captured code");
  return code;
};

const admin = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: sharedUrl }),
);
const owner = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: ownerUrl }),
);
const pools = new Set<Pool>([owner]);
const appRole = `ea_app_${randomBytes(4).toString("hex")}`;
let upgradeName = "";
const poolFor = (url: string) => {
  const pool = createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));
  pools.add(pool);
  return pool;
};

const catalogStubs = `
  CREATE TABLE IF NOT EXISTS public.catalog_entries(
    catalog_id text PRIMARY KEY, province text, province_state text
  );
  CREATE TABLE IF NOT EXISTS public.catalog_discovery(
    catalog_id text PRIMARY KEY, kind text, title text, aliases varchar[],
    first_published_at timestamptz, filter_metadata jsonb
  );
  CREATE TABLE IF NOT EXISTS public.catalog_media(
    catalog_id text, media_id text, object_key text,
    width integer, height integer, is_representative boolean
  );
  -- parallel-community-integration-qa: the notification source query checks
  -- Article visibility against C's published-only projection, so grant-runtime
  -- now names it. Development creates it with the Payload migration
  -- 20260922_015000_editorial_content_views (grant-public-read.sql only grants
  -- it) before the runtime grants run; these suites stand it in the same way as
  -- the Catalog views.
  CREATE TABLE IF NOT EXISTS public.article_entries(
    article_id text PRIMARY KEY, title text
  );
`;

const applyGrants = async (database: Pool, role: string) => {
  const sql = (
    await readFile(
      path.join(root, "infra/development/work-publishing/grant-runtime.sql"),
      "utf8",
    )
  ).replaceAll(':"app_role"', `"${role}"`);
  await database.query(sql);
};

const serviceFor = (
  pool: Pool,
  phone: "simulated" | "disabled" = "simulated",
) =>
  new CommunityAuthService(new PostgresCommunityAuthAdapter(pool), {
    environment: "development",
    profile: phone === "simulated" ? "full-local" : "email-first",
    keys,
    emailMode: "local_capture",
    phoneMode: phone,
    delivery: delivery(),
  });

const register = async (
  service: CommunityAuthService,
  channel: "email" | "phone",
  identifier: string,
  displayName: string,
  source = "127.0.0.1",
) => {
  const sent = await service.sendChallenge({
    channel,
    purpose: "register",
    identifier,
    idempotencyKey: key(),
    source,
  });
  if (!sent.ok || sent.value.continuationToken === undefined)
    throw new Error(sent.ok ? "missing continuation" : sent.reason);
  const verified = await service.verifyChallenge({
    challengeId: sent.value.challengeId,
    code: latest(),
    continuationToken: sent.value.continuationToken,
    idempotencyKey: key(),
  });
  if (!verified.ok || verified.value.outcome !== "registration_required")
    throw new Error(verified.ok ? verified.value.outcome : verified.reason);
  const registered = await service.confirmRegistration({
    handoffToken: verified.value.handoffToken,
    displayName,
    agreement: true,
    idempotencyKey: key(),
  });
  if (!registered.ok) throw new Error(registered.reason);
  return registered.value;
};

const reauthenticate = async (
  service: CommunityAuthService,
  token: string,
  channel: "email" | "phone",
  source = "127.0.0.1",
) => {
  const sent = await service.sendChallenge({
    channel,
    purpose: "reauthenticate",
    idempotencyKey: key(),
    source,
    sessionToken: token,
  });
  if (!sent.ok || sent.value.continuationToken === undefined)
    throw new Error(sent.ok ? "missing continuation" : sent.reason);
  const verified = await service.verifyChallenge({
    challengeId: sent.value.challengeId,
    code: latest(),
    continuationToken: sent.value.continuationToken,
    idempotencyKey: key(),
  });
  if (!verified.ok || verified.value.outcome !== "reauthenticated")
    throw new Error(verified.ok ? verified.value.outcome : verified.reason);
  return verified.value.reauthToken;
};

const appPool = () => {
  const appUrl = new URL(ownerUrl);
  appUrl.username = appRole;
  appUrl.password = "synthetic-test-only";
  return poolFor(appUrl.toString());
};

const serviceAt = (pool: Pool, clock: () => Date, sessionTtlMs?: number) =>
  new CommunityAuthService(new PostgresCommunityAuthAdapter(pool), {
    environment: "development",
    profile: "full-local",
    keys,
    emailMode: "local_capture",
    phoneMode: "simulated",
    delivery: delivery(),
    clock,
    ...(sessionTtlMs === undefined ? {} : { sessionTtlMs }),
  });

const factorRows = async (pool: Pool, userId: string) =>
  (
    await pool.query<{ kind: string; lookup_digest: string }>(
      "SELECT kind, lookup_digest FROM community.user_login_identities WHERE user_id=$1 ORDER BY kind",
      [userId],
    )
  ).rows;

const counted = async (pool: Pool, sql: string, values: readonly unknown[]) =>
  Number(
    (await pool.query<{ count: string }>(sql, [...values])).rows[0]?.count ?? 0,
  );

const installConsumeOnIdentityWrite = () =>
  owner.query(`
    CREATE OR REPLACE FUNCTION community.email_auth_test_consume_reauth()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = community, pg_temp
    AS $fn$
    BEGIN
      UPDATE community.auth_handoffs
      SET consumed_at = CURRENT_TIMESTAMP
      WHERE user_id = COALESCE(NEW.user_id, OLD.user_id)
        AND purpose = 'reauth'
        AND consumed_at IS NULL;
      RETURN COALESCE(NEW, OLD);
    END;
    $fn$;
    DROP TRIGGER IF EXISTS email_auth_test_consume_reauth
      ON community.user_login_identities;
    CREATE TRIGGER email_auth_test_consume_reauth
    AFTER INSERT OR UPDATE OR DELETE ON community.user_login_identities
    FOR EACH ROW EXECUTE FUNCTION community.email_auth_test_consume_reauth();
  `);

const dropConsumeOnIdentityWrite = () =>
  owner.query(`
    DROP TRIGGER IF EXISTS email_auth_test_consume_reauth
      ON community.user_login_identities;
    DROP FUNCTION IF EXISTS community.email_auth_test_consume_reauth();
  `);

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dedicatedName}`);
});

afterAll(async () => {
  await Promise.all([...pools].map((pool) => pool.end()));
  if (upgradeName !== "")
    await admin.query(`DROP DATABASE IF EXISTS ${upgradeName} WITH (FORCE)`);
  await admin.query(`DROP DATABASE IF EXISTS ${dedicatedName} WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS ${appRole}`);
  await admin.end();
});

describe("email-auth PostgreSQL", () => {
  it("upgrades from the pre-auth baseline and a clean install matches the ledger", async () => {
    upgradeName = `email_auth_up_${randomBytes(6).toString("hex")}_synthetic_test`;
    await admin.query(`CREATE DATABASE ${upgradeName}`);
    const upgradeUrl = new URL(ownerUrl);
    upgradeUrl.pathname = `/${upgradeName}`;
    const upgrade = poolFor(upgradeUrl.toString());
    expect(
      await runCommunityMigrations(upgrade, migrationsDirectory, {
        through: baselineMigrationId,
      }),
    ).not.toContain(authMigrationId);
    await expect(
      upgrade.query("SELECT 1 FROM community.user_login_identities"),
    ).rejects.toMatchObject({ code: "42P01" });
    // parallel-community-integration-qa: the combined candidate carries A's auth
    // migration alongside N's notification and C's Thread/Article/DM forward
    // files, so upgrading from the pre-auth baseline applies every manifest
    // entry after it — still including A's, which is what this case asserts.
    const afterBaseline = requiredCommunityMigrations
      .map((file) => file.migrationId)
      .filter((id) => id > baselineMigrationId);
    expect(afterBaseline).toContain(authMigrationId);
    // email-auth-v1 r4 adds the repair migration inside Track A's range.
    expect(afterBaseline).toContain("20260922011000");
    expect(await runCommunityMigrations(upgrade, migrationsDirectory)).toEqual(
      afterBaseline,
    );
    expect(await runCommunityMigrations(upgrade, migrationsDirectory)).toEqual(
      [],
    );
    await owner.query("DROP SCHEMA IF EXISTS community CASCADE");
    expect(await runCommunityMigrations(owner, migrationsDirectory)).toEqual(
      requiredCommunityMigrations.map((file) => file.migrationId),
    );
    expect(await runCommunityMigrations(owner, migrationsDirectory)).toEqual(
      [],
    );
    const ledger = await owner.query<{
      migration_id: string;
      checksum: string;
    }>(
      "SELECT migration_id, checksum FROM community.schema_migrations ORDER BY migration_id",
    );
    expect(ledger.rows.map((row) => row.migration_id)).toEqual(
      requiredCommunityMigrations.map((file) => file.migrationId),
    );
    expect(
      ledger.rows.find((row) => row.migration_id === authMigrationId)?.checksum,
    ).toBe(
      requiredCommunityMigrations.find(
        (file) => file.migrationId === authMigrationId,
      )?.checksum,
    );
    await verifyCommunityMigrationLedger(owner);
  });

  it("converges runtime grants and enforces auth rules as the App role", async () => {
    const role = appRole;
    const password = "synthetic-test-only";
    await owner.query("TRUNCATE TABLE community.public_users CASCADE");
    await owner.query(catalogStubs);
    await owner.query(
      "CREATE TABLE IF NOT EXISTS public.unrelated_acceptance_probe(id integer)",
    );
    await owner.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await owner.query(
      `GRANT CONNECT ON DATABASE ${new URL(ownerUrl).pathname.slice(1)} TO ${role}`,
    );
    await applyGrants(owner, role);
    await applyGrants(owner, role);
    const appUrl = new URL(ownerUrl);
    appUrl.username = role;
    appUrl.password = password;
    const app = poolFor(appUrl.toString());
    await verifyCommunityMigrationLedger(app);
    const service = serviceFor(app);
    const email = await register(
      service,
      "email",
      "pg-owner@example.com",
      "库测",
    );
    const again = await service.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: "pg-owner@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
    });
    await service.signOut(email.token);
    if (!again.ok || again.value.continuationToken === undefined)
      throw new Error("sign-in send");
    const signed = await service.verifyChallenge({
      challengeId: again.value.challengeId,
      code: latest(),
      continuationToken: again.value.continuationToken,
      idempotencyKey: key(),
    });
    expect(
      signed.ok &&
        signed.value.outcome === "signed_in" &&
        signed.value.session.profile.id,
    ).toBe(email.profile.id);
    expect(await service.readAccount(email.token)).toMatchObject({
      ok: false,
      reason: "AUTH_UNAUTHENTICATED",
    });
    const revoked = await app.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM community.sessions WHERE user_id=$1 ORDER BY issued_at",
      [email.profile.id],
    );
    expect(revoked.rows.some((row) => row.revoked_at !== null)).toBe(true);

    const current =
      signed.ok && signed.value.outcome === "signed_in"
        ? signed.value.session.token
        : "";
    const proof = await reauthenticate(service, current, "email");
    const linked = await service.sendChallenge({
      channel: "phone",
      purpose: "link",
      identifier: "13800138001",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: current,
      reauthToken: proof,
    });
    if (!linked.ok || linked.value.continuationToken === undefined)
      throw new Error("link");
    const bound = await service.completeFactor({
      challengeId: linked.value.challengeId,
      code: latest(),
      continuationToken: linked.value.continuationToken,
      reauthToken: proof,
      expectedVersion: 0,
      idempotencyKey: key(),
      sessionToken: current,
    });
    expect(bound.ok && bound.value.account.userId).toBe(email.profile.id);
    if (!bound.ok) return;
    const phoneToken = bound.value.session.token;
    await service.signOut(phoneToken);
    const phoneSignIn = await service.sendChallenge({
      channel: "phone",
      purpose: "sign_in",
      identifier: "+8613800138001",
      idempotencyKey: key(),
      source: "127.0.0.1",
    });
    if (!phoneSignIn.ok || phoneSignIn.value.continuationToken === undefined)
      throw new Error("phone sign-in");
    const byPhone = await service.verifyChallenge({
      challengeId: phoneSignIn.value.challengeId,
      code: latest(),
      continuationToken: phoneSignIn.value.continuationToken,
      idempotencyKey: key(),
    });
    expect(
      byPhone.ok &&
        byPhone.value.outcome === "signed_in" &&
        byPhone.value.session.profile.id,
    ).toBe(email.profile.id);

    const phoneAccount = await register(
      service,
      "phone",
      "13900139000",
      "手机户",
    );
    const phoneProof = await reauthenticate(
      service,
      phoneAccount.token,
      "phone",
    );
    const emailLink = await service.sendChallenge({
      channel: "email",
      purpose: "link",
      identifier: "phone-first@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: phoneAccount.token,
      reauthToken: phoneProof,
    });
    if (!emailLink.ok || emailLink.value.continuationToken === undefined)
      throw new Error("email link");
    const emailBound = await service.completeFactor({
      challengeId: emailLink.value.challengeId,
      code: latest(),
      continuationToken: emailLink.value.continuationToken,
      reauthToken: phoneProof,
      expectedVersion: 0,
      idempotencyKey: key(),
      sessionToken: phoneAccount.token,
    });
    expect(emailBound.ok && emailBound.value.account.userId).toBe(
      phoneAccount.profile.id,
    );
    if (emailBound.ok) {
      const token = emailBound.value.session.token;
      const emailProof = await reauthenticate(service, token, "email");
      const phoneProof = await reauthenticate(service, token, "phone");
      const [dropEmail, dropPhone] = await Promise.all([
        service.unlinkFactor({
          channel: "email",
          reauthToken: emailProof,
          expectedVersion: emailBound.value.account.email.version,
          idempotencyKey: key(),
          sessionToken: token,
        }),
        service.unlinkFactor({
          channel: "phone",
          reauthToken: phoneProof,
          expectedVersion: emailBound.value.account.phone.version,
          idempotencyKey: key(),
          sessionToken: token,
        }),
      ]);
      expect([dropEmail, dropPhone].filter((result) => result.ok)).toHaveLength(
        1,
      );
      const remaining = await app.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM community.user_login_identities WHERE user_id=$1",
        [phoneAccount.profile.id],
      );
      expect(Number(remaining.rows[0]?.count)).toBe(1);
    }
    const users = await app.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM community.public_users",
    );
    const identities = await app.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM community.user_login_identities",
    );
    expect(Number(users.rows[0]?.count)).toBe(2);
    // The concurrent unlink keeps one factor on the phone-created account.
    expect(Number(identities.rows[0]?.count)).toBe(3);

    for (const sql of [
      "UPDATE community.user_login_identities SET user_id=user_id",
      "UPDATE community.user_login_identities SET verification_mode=verification_mode",
      "UPDATE community.user_login_identities SET environment=environment",
      "UPDATE community.auth_receipts SET origin_session_id=origin_session_id",
      "UPDATE community.sessions SET user_id=user_id",
      "DELETE FROM community.public_users",
      "CREATE TABLE community.qa_forbidden(id int)",
      "UPDATE community.schema_migrations SET checksum=checksum",
      "INSERT INTO community.development_accounts(user_id, label) VALUES ('user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'x')",
      `ALTER ROLE ${appRole} SUPERUSER`,
      "CREATE ROLE email_auth_escalated LOGIN",
      "SELECT id FROM public.unrelated_acceptance_probe",
    ])
      await expect(app.query(sql)).rejects.toMatchObject({ code: "42501" });
    const owners = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM community.account_publishing_capacity WHERE capacity_class='owner'",
    );
    expect(Number(owners.rows[0]?.count)).toBe(0);

    await owner.query(
      "UPDATE community.user_login_identities SET verification_mode='provider' WHERE kind='email' AND environment='development'",
    );
    const tainted = await service.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: "pg-owner@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
    });
    if (!tainted.ok || tainted.value.continuationToken === undefined)
      throw new Error("tainted sign-in");
    expect(
      await service.verifyChallenge({
        challengeId: tainted.value.challengeId,
        code: latest(),
        continuationToken: tainted.value.continuationToken,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_PROVENANCE_REJECTED" });
    const emailFirst = serviceFor(app, "disabled");
    expect(
      await emailFirst.sendChallenge({
        channel: "phone",
        purpose: "sign_in",
        identifier: "+8613800138001",
        idempotencyKey: key(),
        source: "127.0.0.1",
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_CHANNEL_UNAVAILABLE" });

    expect(() =>
      assertProductionAuthConfiguration({
        NODE_ENV: "production",
        AUTH_PROFILE: "full-local",
      }),
    ).toThrow(/Production rejects/);
    expect(
      createDevelopmentAuthService(new PostgresCommunityAuthAdapter(app), {
        NODE_ENV: "development",
      }),
    ).toBeNull();
  });

  it("rejects duplicate, stale, replayed and cross-purpose proofs", async () => {
    const appUrl = new URL(ownerUrl);
    appUrl.username = appRole;
    appUrl.password = "synthetic-test-only";
    const service = serviceFor(poolFor(appUrl.toString()));
    const sent = await service.sendChallenge({
      channel: "email",
      purpose: "register",
      identifier: "race@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
    });
    if (!sent.ok || sent.value.continuationToken === undefined)
      throw new Error("race send");
    const verified = await service.verifyChallenge({
      challengeId: sent.value.challengeId,
      code: latest(),
      continuationToken: sent.value.continuationToken,
      idempotencyKey: key(),
    });
    if (!verified.ok || verified.value.outcome !== "registration_required")
      throw new Error("race verify");
    const idempotencyKey = key();
    const [first, second] = await Promise.all([
      service.confirmRegistration({
        handoffToken: verified.value.handoffToken,
        displayName: "竞态甲",
        agreement: true,
        idempotencyKey,
      }),
      service.confirmRegistration({
        handoffToken: verified.value.handoffToken,
        displayName: "竞态乙",
        agreement: true,
        idempotencyKey: key(),
      }),
    ]);
    const winners = [first, second].filter((result) => result.ok);
    expect(winners).toHaveLength(1);
    const replay = await service.verifyChallenge({
      challengeId: sent.value.challengeId,
      code: latest(),
      continuationToken: sent.value.continuationToken,
      idempotencyKey: key(),
    });
    expect(replay).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    if (!first.ok && !second.ok) return;
    const winner = first.ok ? first.value : second.ok ? second.value : null;
    if (winner === null) return;
    const proof = await reauthenticate(service, winner.token, "email");
    const replace = await service.sendChallenge({
      channel: "email",
      purpose: "replace",
      identifier: "pg-owner@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: winner.token,
      reauthToken: proof,
    });
    if (!replace.ok || replace.value.continuationToken === undefined)
      throw new Error("replace");
    expect(
      await service.completeFactor({
        challengeId: replace.value.challengeId,
        code: latest(),
        continuationToken: replace.value.continuationToken,
        reauthToken: proof,
        expectedVersion: 1,
        idempotencyKey: key(),
        sessionToken: winner.token,
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_IDENTIFIER_CONFLICT" });
    const own = await service.sendChallenge({
      channel: "email",
      purpose: "replace",
      identifier: "replacement@example.com",
      idempotencyKey: key(),
      source: "127.0.0.1",
      sessionToken: winner.token,
      reauthToken: proof,
    });
    if (!own.ok || own.value.continuationToken === undefined)
      throw new Error("own replace");
    expect(
      await service.completeFactor({
        challengeId: own.value.challengeId,
        code: latest(),
        continuationToken: own.value.continuationToken,
        reauthToken: proof,
        expectedVersion: 99,
        idempotencyKey: key(),
        sessionToken: winner.token,
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_STALE_VERSION" });
    expect(
      await service.completeFactor({
        challengeId: sent.value.challengeId,
        code: "000000",
        continuationToken: sent.value.continuationToken,
        reauthToken: proof,
        expectedVersion: 1,
        idempotencyKey: key(),
        sessionToken: winner.token,
      }),
    ).toMatchObject({ ok: false });
  });

  it("rolls back bind, replace, and unlink when the handoff fails after the identity write", async () => {
    const pool = appPool();
    const service = serviceFor(pool);
    const source = "127.0.0.61";
    const user = await register(
      service,
      "email",
      "atomic-bind@example.com",
      "原子绑定",
      source,
    );
    const proof = await reauthenticate(service, user.token, "email", source);
    const link = await service.sendChallenge({
      channel: "phone",
      purpose: "link",
      identifier: "13800138611",
      idempotencyKey: key(),
      source,
      sessionToken: user.token,
      reauthToken: proof,
    });
    if (!link.ok || link.value.continuationToken === undefined)
      throw new Error("atomic link");
    const phoneCode = latest();
    await installConsumeOnIdentityWrite();
    try {
      expect(
        await service.completeFactor({
          challengeId: link.value.challengeId,
          code: phoneCode,
          continuationToken: link.value.continuationToken,
          reauthToken: proof,
          expectedVersion: 0,
          idempotencyKey: key(),
          sessionToken: user.token,
        }),
      ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    } finally {
      await dropConsumeOnIdentityWrite();
    }
    expect(
      (await factorRows(pool, user.profile.id)).map((row) => row.kind),
    ).toEqual(["email"]);
    expect((await service.readAccount(user.token)).ok).toBe(true);
    const bound = await service.completeFactor({
      challengeId: link.value.challengeId,
      code: phoneCode,
      continuationToken: link.value.continuationToken,
      reauthToken: proof,
      expectedVersion: 0,
      idempotencyKey: key(),
      sessionToken: user.token,
    });
    expect(bound.ok && bound.value.account.phone.state).toBe("verified");
    if (!bound.ok) return;

    const beforeReplace = await factorRows(pool, user.profile.id);
    const emailDigest = beforeReplace.find(
      (row) => row.kind === "email",
    )?.lookup_digest;
    const replaceProof = await reauthenticate(
      service,
      bound.value.session.token,
      "phone",
      source,
    );
    const replacement = await service.sendChallenge({
      channel: "email",
      purpose: "replace",
      identifier: "atomic-replace@example.com",
      idempotencyKey: key(),
      source,
      sessionToken: bound.value.session.token,
      reauthToken: replaceProof,
    });
    if (!replacement.ok || replacement.value.continuationToken === undefined)
      throw new Error("atomic replace");
    const replaceCode = latest();
    await installConsumeOnIdentityWrite();
    try {
      expect(
        await service.completeFactor({
          challengeId: replacement.value.challengeId,
          code: replaceCode,
          continuationToken: replacement.value.continuationToken,
          reauthToken: replaceProof,
          expectedVersion: bound.value.account.email.version,
          idempotencyKey: key(),
          sessionToken: bound.value.session.token,
        }),
      ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    } finally {
      await dropConsumeOnIdentityWrite();
    }
    expect(
      (await factorRows(pool, user.profile.id)).find(
        (row) => row.kind === "email",
      )?.lookup_digest,
    ).toBe(emailDigest);
    expect(
      await service.completeFactor({
        challengeId: replacement.value.challengeId,
        code: replaceCode,
        continuationToken: replacement.value.continuationToken,
        reauthToken: replaceProof,
        expectedVersion: 99,
        idempotencyKey: key(),
        sessionToken: bound.value.session.token,
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_STALE_VERSION" });
    expect(
      (await factorRows(pool, user.profile.id)).find(
        (row) => row.kind === "email",
      )?.lookup_digest,
    ).toBe(emailDigest);
    const replaced = await service.completeFactor({
      challengeId: replacement.value.challengeId,
      code: replaceCode,
      continuationToken: replacement.value.continuationToken,
      reauthToken: replaceProof,
      expectedVersion: bound.value.account.email.version,
      idempotencyKey: key(),
      sessionToken: bound.value.session.token,
    });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(
      (await factorRows(pool, user.profile.id)).find(
        (row) => row.kind === "email",
      )?.lookup_digest,
    ).not.toBe(emailDigest);

    const unlinkProof = await reauthenticate(
      service,
      replaced.value.session.token,
      "phone",
      source,
    );
    await installConsumeOnIdentityWrite();
    try {
      expect(
        await service.unlinkFactor({
          channel: "email",
          reauthToken: unlinkProof,
          expectedVersion: replaced.value.account.email.version,
          idempotencyKey: key(),
          sessionToken: replaced.value.session.token,
        }),
      ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    } finally {
      await dropConsumeOnIdentityWrite();
    }
    expect(
      (await factorRows(pool, user.profile.id)).map((row) => row.kind),
    ).toEqual(["email", "phone"]);
    expect(
      (
        await service.unlinkFactor({
          channel: "email",
          reauthToken: unlinkProof,
          expectedVersion: replaced.value.account.email.version,
          idempotencyKey: key(),
          sessionToken: replaced.value.session.token,
        })
      ).ok,
    ).toBe(true);
  });

  it("keeps the losing concurrent proof from changing a second factor", async () => {
    const pool = appPool();
    const setup = serviceFor(pool);
    const source = "127.0.0.62";
    const user = await register(
      setup,
      "email",
      "atomic-race@example.com",
      "原子竞态",
      source,
    );
    const linkProof = await reauthenticate(setup, user.token, "email", source);
    const link = await setup.sendChallenge({
      channel: "phone",
      purpose: "link",
      identifier: "13800138622",
      idempotencyKey: key(),
      source,
      sessionToken: user.token,
      reauthToken: linkProof,
    });
    if (!link.ok || link.value.continuationToken === undefined)
      throw new Error("race link");
    const linked = await setup.completeFactor({
      challengeId: link.value.challengeId,
      code: latest(),
      continuationToken: link.value.continuationToken,
      reauthToken: linkProof,
      expectedVersion: 0,
      idempotencyKey: key(),
      sessionToken: user.token,
    });
    if (!linked.ok) throw new Error("race bind");
    const token = linked.value.session.token;
    const proof = await reauthenticate(setup, token, "phone", source);
    const original = await factorRows(pool, user.profile.id);
    const originalEmail = original.find(
      (row) => row.kind === "email",
    )?.lookup_digest;
    const replacement = await setup.sendChallenge({
      channel: "email",
      purpose: "replace",
      identifier: "atomic-race-next@example.com",
      idempotencyKey: key(),
      source,
      sessionToken: token,
      reauthToken: proof,
    });
    if (!replacement.ok || replacement.value.continuationToken === undefined)
      throw new Error("race replace");
    const replaceCode = latest();
    let arrived = 0;
    let release: () => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      release = () => resolve();
      setTimeout(() => reject(new Error("proof race did not meet")), 5_000);
    });
    const racing = new CommunityAuthService(
      {
        transaction: (work) =>
          new PostgresCommunityAuthAdapter(pool).transaction((tx) =>
            work({
              ...tx,
              findHandoff: async (hash) => {
                const row = await tx.findHandoff(hash);
                arrived += 1;
                if (arrived >= 2) release();
                else await ready;
                return row;
              },
            }),
          ),
      },
      {
        environment: "development",
        profile: "full-local",
        keys,
        emailMode: "local_capture",
        phoneMode: "simulated",
        delivery: delivery(),
      },
    );
    const [unlinked, replaced] = await Promise.all([
      racing.unlinkFactor({
        channel: "phone",
        reauthToken: proof,
        expectedVersion: linked.value.account.phone.version,
        idempotencyKey: key(),
        sessionToken: token,
      }),
      racing.completeFactor({
        challengeId: replacement.value.challengeId,
        code: replaceCode,
        continuationToken: replacement.value.continuationToken,
        reauthToken: proof,
        expectedVersion: linked.value.account.email.version,
        idempotencyKey: key(),
        sessionToken: token,
      }),
    ]);
    expect([unlinked, replaced].filter((result) => result.ok)).toHaveLength(1);
    const factors = await factorRows(pool, user.profile.id);
    if (unlinked.ok) {
      expect(replaced).toMatchObject({
        ok: false,
        reason: "AUTH_PROOF_REJECTED",
      });
      expect(factors.map((row) => row.kind)).toEqual(["email"]);
      expect(factors[0]?.lookup_digest).toBe(originalEmail);
      return;
    }
    expect(unlinked).toMatchObject({
      ok: false,
      reason: "AUTH_PROOF_REJECTED",
    });
    expect(factors.map((row) => row.kind)).toEqual(["email", "phone"]);
    expect(factors.find((row) => row.kind === "email")?.lookup_digest).not.toBe(
      originalEmail,
    );
  });

  it("records equal-timestamp wrong attempts without a uniqueness failure", async () => {
    const pool = appPool();
    const fixed = new Date("2026-09-22T15:00:00.000Z");
    const service = serviceAt(pool, () => fixed);
    const source = "127.0.0.63";
    const user = await register(
      service,
      "email",
      "atomic-attempt@example.com",
      "原子次数",
      source,
    );
    await service.signOut(user.token);
    const sent = await service.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: "atomic-attempt@example.com",
      idempotencyKey: key(),
      source,
    });
    if (!sent.ok || sent.value.continuationToken === undefined)
      throw new Error("attempt send");
    const before = await counted(
      pool,
      "SELECT count(*)::text AS count FROM community.auth_target_failures",
      [],
    );
    const wrong = {
      challengeId: sent.value.challengeId,
      code: "000000",
      continuationToken: sent.value.continuationToken,
    };
    const concurrent = await Promise.all([
      service.verifyChallenge({ ...wrong, idempotencyKey: key() }),
      service.verifyChallenge({ ...wrong, idempotencyKey: key() }),
    ]);
    expect(concurrent).toEqual([
      { ok: false, reason: "AUTH_CODE_INVALID" },
      { ok: false, reason: "AUTH_CODE_INVALID" },
    ]);
    expect(
      (await counted(
        pool,
        "SELECT count(*)::text AS count FROM community.auth_target_failures",
        [],
      )) - before,
    ).toBe(2);
    const signed = await service.verifyChallenge({
      challengeId: sent.value.challengeId,
      code: latest(),
      continuationToken: sent.value.continuationToken,
      idempotencyKey: key(),
    });
    expect(signed.ok && signed.value.outcome).toBe("signed_in");

    await register(
      service,
      "email",
      "atomic-exhaust@example.com",
      "原子耗尽",
      source,
    );
    const exhausted = await service.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: "atomic-exhaust@example.com",
      idempotencyKey: key(),
      source,
    });
    if (!exhausted.ok || exhausted.value.continuationToken === undefined)
      throw new Error("exhaust send");
    const mark = await counted(
      pool,
      "SELECT count(*)::text AS count FROM community.auth_target_failures",
      [],
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        await service.verifyChallenge({
          challengeId: exhausted.value.challengeId,
          code: "000000",
          continuationToken: exhausted.value.continuationToken,
          idempotencyKey: key(),
        }),
      ).toMatchObject({ ok: false, reason: "AUTH_CODE_INVALID" });
    }
    expect(
      (await counted(
        pool,
        "SELECT count(*)::text AS count FROM community.auth_target_failures",
        [],
      )) - mark,
    ).toBe(5);
    expect(
      await service.verifyChallenge({
        challengeId: exhausted.value.challengeId,
        code: latest(),
        continuationToken: exhausted.value.continuationToken,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_CODE_EXHAUSTED" });
  });

  it("stops a sign-in receipt from minting a session after logout", async () => {
    const pool = appPool();
    let now = new Date("2026-09-22T16:00:00.000Z");
    const service = serviceAt(pool, () => now, 60_000);
    const source = "127.0.0.64";
    const user = await register(
      service,
      "email",
      "atomic-receipt@example.com",
      "原子回执",
      source,
    );
    await service.signOut(user.token);
    const sent = await service.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: "atomic-receipt@example.com",
      idempotencyKey: key(),
      source,
    });
    if (!sent.ok || sent.value.continuationToken === undefined)
      throw new Error("receipt send");
    const idempotencyKey = key();
    const verify = {
      challengeId: sent.value.challengeId,
      code: latest(),
      continuationToken: sent.value.continuationToken,
      idempotencyKey,
    };
    const first = await service.verifyChallenge(verify);
    const retry = await service.verifyChallenge(verify);
    expect(first.ok && first.value.outcome).toBe("signed_in");
    expect(retry.ok && retry.value.outcome).toBe("signed_in");
    if (
      !first.ok ||
      first.value.outcome !== "signed_in" ||
      !retry.ok ||
      retry.value.outcome !== "signed_in"
    )
      return;
    expect(retry.value.session.profile.id).toBe(user.profile.id);
    expect((await service.readAccount(retry.value.session.token)).ok).toBe(
      true,
    );
    expect(await service.readAccount(first.value.session.token)).toMatchObject({
      ok: false,
      reason: "AUTH_UNAUTHENTICATED",
    });
    const sessionsBeforeLogout = await counted(
      pool,
      "SELECT count(*)::text AS count FROM community.sessions WHERE user_id=$1",
      [user.profile.id],
    );
    expect(await service.signOut(retry.value.session.token)).toMatchObject({
      ok: true,
      value: { signedOut: true },
    });
    expect(await service.readAccount(retry.value.session.token)).toMatchObject({
      ok: false,
      reason: "AUTH_UNAUTHENTICATED",
    });
    const replay = await service.verifyChallenge(verify);
    expect(replay.ok).toBe(false);
    expect(
      await counted(
        pool,
        "SELECT count(*)::text AS count FROM community.sessions WHERE user_id=$1",
        [user.profile.id],
      ),
    ).toBe(sessionsBeforeLogout);
    expect(
      await counted(
        pool,
        "SELECT count(*)::text AS count FROM community.sessions WHERE user_id=$1 AND revoked_at IS NULL",
        [user.profile.id],
      ),
    ).toBe(0);
    const fresh = await service.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: "atomic-receipt@example.com",
      idempotencyKey: key(),
      source,
    });
    if (!fresh.ok || fresh.value.continuationToken === undefined)
      throw new Error("fresh send");
    const freshCode = latest();
    const freshKey = key();
    const freshBody = {
      challengeId: fresh.value.challengeId,
      code: freshCode,
      continuationToken: fresh.value.continuationToken,
      idempotencyKey: freshKey,
    };
    const again = await service.verifyChallenge(freshBody);
    expect(again.ok && again.value.outcome).toBe("signed_in");
    if (!again.ok || again.value.outcome !== "signed_in") return;
    expect((await service.readAccount(again.value.session.token)).ok).toBe(
      true,
    );
    expect(await service.verifyChallenge(verify)).toMatchObject({ ok: false });
    now = new Date(now.getTime() + 60_001);
    expect(await service.readAccount(again.value.session.token)).toMatchObject({
      ok: false,
      reason: "AUTH_UNAUTHENTICATED",
    });
    const expiredSessions = await counted(
      pool,
      "SELECT count(*)::text AS count FROM community.sessions WHERE user_id=$1",
      [user.profile.id],
    );
    expect(await service.verifyChallenge(freshBody)).toMatchObject({
      ok: false,
    });
    expect(
      await counted(
        pool,
        "SELECT count(*)::text AS count FROM community.sessions WHERE user_id=$1",
        [user.profile.id],
      ),
    ).toBe(expiredSessions);

    const raced = await service.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: "atomic-receipt@example.com",
      idempotencyKey: key(),
      source,
    });
    if (!raced.ok || raced.value.continuationToken === undefined)
      throw new Error("race send");
    const raceCode = latest();
    const raceKey = key();
    const opened = await service.verifyChallenge({
      challengeId: raced.value.challengeId,
      code: raceCode,
      continuationToken: raced.value.continuationToken,
      idempotencyKey: raceKey,
    });
    if (!opened.ok || opened.value.outcome !== "signed_in")
      throw new Error("race open");
    const body = {
      challengeId: raced.value.challengeId,
      code: raceCode,
      continuationToken: raced.value.continuationToken,
      idempotencyKey: raceKey,
    };
    await Promise.all([
      service.signOut(opened.value.session.token),
      service.verifyChallenge(body),
    ]);
    expect(
      await counted(
        pool,
        "SELECT count(*)::text AS count FROM community.sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > $2",
        [user.profile.id, now.toISOString()],
      ),
    ).toBe(0);
    expect(await service.verifyChallenge(body)).toMatchObject({ ok: false });
    expect((await service.readAccount(opened.value.session.token)).ok).toBe(
      false,
    );
  });

  describe("password auth PostgreSQL App-role parity", () => {
    beforeAll(async () => {
      // The focused suite also works when prior OTP cases are filtered out.
      await runCommunityMigrations(owner, migrationsDirectory);
      await owner.query(catalogStubs);
      const existing = await owner.query(
        "SELECT 1 FROM pg_roles WHERE rolname=$1",
        [appRole],
      );
      if (existing.rowCount === 0)
        await owner.query(
          `CREATE ROLE ${appRole} LOGIN PASSWORD 'synthetic-test-only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
        );
      await owner.query(
        `GRANT CONNECT ON DATABASE ${new URL(ownerUrl).pathname.slice(1)} TO ${appRole}`,
      );
      await applyGrants(owner, appRole);
    });
    beforeEach(async () => {
      await owner.query("TRUNCATE TABLE community.public_users CASCADE");
      await owner.query(
        "TRUNCATE TABLE community.auth_send_counters,community.auth_target_failures",
      );
      codes.length = 0;
    });
    const makePasswordHarness = () => {
      let now = new Date("2026-09-30T12:00:00Z");
      const pool = appPool();
      const serviceForPort = (
        port: import("@moya/api").CommunityAuthPort,
        deliveryOverride?: AuthDeliveryPorts,
      ) =>
        new CommunityAuthService(port, {
          environment: "development",
          profile: "full-local",
          keys,
          emailMode: "local_capture",
          phoneMode: "simulated",
          delivery: deliveryOverride ?? delivery(),
          clock: () => now,
        });
      return {
        service: serviceAt(pool, () => now),
        port: new PostgresCommunityAuthAdapter(pool),
        latestCode: latest,
        serviceForPort,
        suspend: async (id: string) => {
          await owner.query(
            "UPDATE community.public_users SET status='suspended' WHERE id=$1",
            [id],
          );
        },
        advance: (ms: number) => {
          now = new Date(now.getTime() + ms);
        },
      };
    };
    passwordAuthCases(makePasswordHarness);
    it("locks the user before the challenge and re-reads invalidation when reset interleaves", async () => {
      const h = makePasswordHarness(),
        email = `${key()}@example.invalid`;
      const original = await registerPasswordCase(h, email),
        command = await preparePasswordResetCase(h, email);
      const sent = await h.service.sendChallenge({
        channel: "email",
        purpose: "sign_in",
        identifier: email,
        idempotencyKey: key(),
        source: "gated-pg",
      });
      if (!sent.ok || !sent.value.continuationToken)
        throw Error("Synthetic OTP rejected");
      const code = latest();
      let release!: () => void,
        readReached!: () => void,
        resetReached!: () => void,
        gated = false;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        readReached = resolve;
      });
      const resetWriting = new Promise<void>((resolve) => {
        resetReached = resolve;
      });
      const reader: import("@moya/api").CommunityAuthPort = {
        transaction: (work) =>
          h.port.transaction((tx) =>
            work({
              ...tx,
              lockUser: async (id) => {
                if (!gated && id === original.session.profile.id) {
                  gated = true;
                  readReached();
                  await paused;
                }
                return tx.lockUser(id);
              },
            }),
          ),
      };
      const writer: import("@moya/api").CommunityAuthPort = {
        transaction: (work) =>
          h.port.transaction((tx) =>
            work({
              ...tx,
              invalidatePasswordResetProofs: async (id, at) => {
                resetReached();
                await tx.invalidatePasswordResetProofs(id, at);
              },
            }),
          ),
      };
      const verifying = h.serviceForPort(reader).verifyChallenge({
        challengeId: sent.value.challengeId,
        continuationToken: sent.value.continuationToken,
        code,
        idempotencyKey: key(),
      });
      await ready;
      const resetting = h.serviceForPort(writer).resetPassword(command);
      await resetWriting;
      release();
      const [verified, reset] = await Promise.all([verifying, resetting]);
      expect(reset.ok).toBe(true);
      expect(verified.ok).toBe(false);
      expect((await h.service.readAccount(original.session.token)).ok).toBe(
        false,
      );
    });
  });
});
