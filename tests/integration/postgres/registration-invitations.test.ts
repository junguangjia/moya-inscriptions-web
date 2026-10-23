import { randomBytes } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthUnitOfWork } from "@moya/api";
import { CommunityStoreUnavailableError } from "@moya/api";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresCommunityAuthAdapter,
  createPostgresBetaAccountAccess,
  runCommunityMigrations,
} from "@moya/community-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const sharedUrl = requireSyntheticTestDatabaseUrl();
const name = `invitations_${randomBytes(5).toString("hex")}_synthetic_test`;
const role = `inv_app_${randomBytes(5).toString("hex")}`;
const ownerUrl = new URL(sharedUrl);
ownerUrl.pathname = `/${name}`;
const appUrl = new URL(ownerUrl);
appUrl.username = role;
appUrl.password = "synthetic-invitation-test-only";
const admin = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: sharedUrl }),
);
const owner = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: ownerUrl.toString() }),
);
const app = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: appUrl.toString() }),
);
const adapter = new PostgresCommunityAuthAdapter(app);
const access = createPostgresBetaAccountAccess(app);
const opaque = (prefix: string) =>
  `${prefix}-${randomBytes(16).toString("hex")}`;
const digest = () => randomBytes(32).toString("hex");
let directory: string;
let fileIndex = 0;
const cli = await import(
  new URL(
    "../../../scripts/manage-registration-invitations.mjs",
    import.meta.url,
  ).href
);
const create = async (maxUses = 20) => {
  const outputFile = join(directory, `invitation-${fileIndex++}.json`);
  const result = await cli.manageRegistrationInvitations(
    owner,
    { action: "create", maxUses, expiresInDays: 7, outputFile },
    "production",
  );
  const content = JSON.parse(await readFile(outputFile, "utf8"));
  return {
    id: result.id as string,
    digest: cli.registrationInvitationDigest(content.invitationCode) as string,
  };
};
const insertRegistration = async (
  tx: AuthUnitOfWork,
  invitationId: string,
  userId: string,
  options: {
    environment?: "production" | "development";
    consumed?: boolean;
    invitation?: boolean;
  } = {},
) => {
  const environment = options.environment ?? "production";
  const targetDigest = digest();
  const at = new Date().toISOString();
  const handoffId = opaque("handoff");
  await tx.insertUser({
    id: userId,
    handle: `synthetic-${randomBytes(5).toString("hex")}`,
    displayName: "Synthetic invite user",
    status: "active",
  });
  await tx.insertIdentity({
    id: opaque("login"),
    userId,
    kind: "email",
    lookupDigest: targetDigest,
    ciphertext: "synthetic-encrypted-fixture",
    lookupKeyVersion: 1,
    verificationMode: "provider",
    environment,
    version: 1,
    verifiedAt: at,
  });
  if (options.invitation !== false)
    await tx.insertHandoff({
      id: handoffId,
      tokenHash: digest(),
      purpose: "register_confirm",
      channel: "email",
      targetDigest,
      ciphertext: "synthetic-encrypted-fixture",
      providerMode: "provider",
      environment,
      userId: null,
      sessionHash: null,
      expectedVersion: null,
      invitationId,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      consumedAt: options.consumed ? at : null,
    });
  return { at, handoffId };
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "synthetic-pg-invitations-"));
  await admin.query(`CREATE DATABASE ${name}`);
  await runCommunityMigrations(
    owner,
    join(root, "database/community-migrations"),
  );
  await owner.query(`CREATE TABLE public.catalog_entries(catalog_id text,province text,province_state text);
    CREATE TABLE public.catalog_discovery(catalog_id text);
    CREATE TABLE public.catalog_media(catalog_id text);
    CREATE TABLE public.article_entries(article_id text);`);
  await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-invitation-test-only'
    NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  await owner.query(`GRANT CONNECT ON DATABASE ${name} TO ${role}`);
  const grants = (
    await readFile(
      join(root, "infra/development/work-publishing/grant-runtime.sql"),
      "utf8",
    )
  ).replaceAll(':"app_role"', `"${role}"`);
  await owner.query(grants);
}, 30000);
afterAll(async () => {
  await Promise.all([owner.end(), app.end()]);
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS ${role}`);
  await admin.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("registration invitation PostgreSQL authority", () => {
  it("uses hash-only operator creation, maps invitation lookup and denies runtime management/DML", async () => {
    const invitation = await create();
    const selected = await adapter.transaction((tx) =>
      tx.findInvitationByDigest(invitation.digest, "production"),
    );
    expect(selected).toMatchObject({
      id: invitation.id,
      maxUses: 20,
      usedCount: 0,
      environment: "production",
    });
    expect(
      await adapter.transaction((tx) =>
        tx.findInvitationByDigest(invitation.digest, "development"),
      ),
    ).toBeNull();
    expect(
      (await adapter.transaction((tx) => tx.lockInvitation(invitation.id)))?.id,
    ).toBe(invitation.id);
    await expect(
      cli.manageRegistrationInvitations(
        app,
        { action: "status" },
        "production",
      ),
    ).rejects.toThrow("REGISTRATION_INVITATION_OPERATION_REFUSED");
    for (const sql of [
      "UPDATE community.registration_invitations SET used_count=0",
      "DELETE FROM community.registration_invitations",
      "INSERT INTO community.registration_invitations SELECT * FROM community.registration_invitations",
      "INSERT INTO community.registration_invitation_redemptions SELECT * FROM community.registration_invitation_redemptions",
      "INSERT INTO community.beta_account_access SELECT * FROM community.beta_account_access",
      "UPDATE community.beta_account_access SET state='granted'",
      "DELETE FROM community.beta_account_access",
    ])
      await expect(app.query(sql)).rejects.toMatchObject({ code: "42501" });
  });

  it("atomically grants one registration, rolls back all effects and replays without consuming twice", async () => {
    const invitation = await create();
    const rolledBack = opaque("user");
    await expect(
      adapter.transaction(async (tx) => {
        const { at, handoffId } = await insertRegistration(
          tx,
          invitation.id,
          rolledBack,
        );
        expect(
          await tx.redeemInvitation(invitation.id, rolledBack, at, handoffId),
        ).toBe(true);
        throw Error("Synthetic registration rollback");
      }),
    ).rejects.toThrow("Synthetic registration rollback");
    expect(await access.read(rolledBack)).toBe("none");
    expect(
      (
        await owner.query("SELECT id FROM community.public_users WHERE id=$1", [
          rolledBack,
        ])
      ).rowCount,
    ).toBe(0);
    const userId = opaque("user");
    await adapter.transaction(async (tx) => {
      const { at, handoffId } = await insertRegistration(
        tx,
        invitation.id,
        userId,
      );
      expect(
        await tx.redeemInvitation(invitation.id, userId, at, handoffId),
      ).toBe(true);
      expect(
        await tx.redeemInvitation(invitation.id, userId, at, handoffId),
      ).toBe(true);
    });
    expect(await access.read(userId)).toBe("granted");
    const otherInvitation = await create();
    expect(
      await adapter.transaction((tx) =>
        tx.redeemInvitation(
          otherInvitation.id,
          userId,
          new Date().toISOString(),
          opaque("handoff"),
        ),
      ),
    ).toBe(false);
    expect(
      (await adapter.transaction((tx) => tx.lockInvitation(invitation.id)))
        ?.usedCount,
    ).toBe(1);
    await cli.manageRegistrationInvitations(
      owner,
      { action: "revoke", id: invitation.id },
      "production",
    );
    expect(await access.read(userId)).toBe("granted");
    await cli.manageRegistrationInvitations(
      owner,
      { action: "revoke-access", id: userId },
      "production",
    );
    expect(await access.read(userId)).toBe("revoked");
    expect(
      await adapter.transaction((tx) =>
        tx.redeemInvitation(
          invitation.id,
          userId,
          new Date().toISOString(),
          opaque("handoff"),
        ),
      ),
    ).toBe(true);
    expect(await access.read(userId)).toBe("revoked");
    await cli.manageRegistrationInvitations(
      owner,
      { action: "restore-access", id: userId },
      "production",
    );
    expect(await access.read(userId)).toBe("granted");
  });

  it("serializes the last quota slot and grants only one concurrent user", async () => {
    const invitation = await create(1);
    const users = [opaque("user"), opaque("user")];
    const results = await Promise.all(
      users.map((userId) =>
        adapter.transaction(async (tx) => {
          const { at, handoffId } = await insertRegistration(
            tx,
            invitation.id,
            userId,
          );
          return tx.redeemInvitation(invitation.id, userId, at, handoffId);
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      (await adapter.transaction((tx) => tx.lockInvitation(invitation.id)))
        ?.usedCount,
    ).toBe(1);
    expect(
      (await Promise.all(users.map((userId) => access.read(userId)))).filter(
        (state) => state === "granted",
      ),
    ).toHaveLength(1);
  });

  it("redeems only its exact handoff while another handoff waits for the same target lock", async () => {
    const invitation = await create(2);
    const targetDigest = digest();
    const [firstHandoff, secondHandoff] = [
      opaque("handoff"),
      opaque("handoff"),
    ];
    for (const id of [firstHandoff, secondHandoff])
      await owner.query(
        `INSERT INTO community.auth_handoffs
        (id,token_hash,purpose,channel,target_digest,ciphertext,provider_mode,environment,expires_at,invitation_id)
        VALUES($1,$2,'register_confirm','email',$3,'synthetic-encrypted-fixture','provider','production',now()+interval '5 minutes',$4)`,
        [id, digest(), targetDigest, invitation.id],
      );
    const first = await app.connect();
    const second = await app.connect();
    let waiting: Promise<boolean> | undefined;
    const userId = opaque("user");
    try {
      for (const client of [first, second]) {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout='3s'");
      }
      await first.query(
        "SELECT id FROM community.auth_handoffs WHERE id=$1 FOR UPDATE",
        [firstHandoff],
      );
      await second.query(
        "SELECT id FROM community.auth_handoffs WHERE id=$1 FOR UPDATE",
        [secondHandoff],
      );
      await first.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        targetDigest,
      ]);
      expect(
        (
          await second.query(
            "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",
            [targetDigest],
          )
        ).rows[0]?.acquired,
      ).toBe(false);
      waiting = second
        .query("SELECT pg_advisory_xact_lock(hashtext($1))", [targetDigest])
        .then(
          () => true,
          () => false,
        );
      await first.query(
        `INSERT INTO community.public_users(id,handle,display_name)
        VALUES($1,$2,'Synthetic same-target registration')`,
        [userId, `synthetic-${randomBytes(5).toString("hex")}`],
      );
      await first.query(
        `INSERT INTO community.user_login_identities
        (id,user_id,kind,lookup_digest,ciphertext,lookup_key_version,verification_mode,environment,version,verified_at)
        VALUES($1,$2,'email',$3,'synthetic-encrypted-fixture',1,'provider','production',1,now())`,
        [opaque("login"), userId, targetDigest],
      );
      expect(
        (
          await first.query(
            "SELECT community.redeem_registration_invitation($1,$2,now(),$3) AS redeemed",
            [invitation.id, userId, firstHandoff],
          )
        ).rows[0]?.redeemed,
      ).toBe(true);
      await first.query("COMMIT");
      expect(await waiting).toBe(true);
      await second.query("ROLLBACK");
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await waiting;
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
    expect(await access.read(userId)).toBe("granted");
    expect(
      (await adapter.transaction((tx) => tx.lockInvitation(invitation.id)))
        ?.usedCount,
    ).toBe(1);
  });

  it("refuses expired/revoked, mismatched proof, absent proof and existing-account admission", async () => {
    for (const mode of [
      "expired",
      "revoked",
      "environment",
      "consumed",
      "absent",
      "existing",
      "wrong-handoff",
    ] as const) {
      const invitation = await create();
      if (mode === "expired")
        await owner.query(
          "UPDATE community.registration_invitations SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",
          [invitation.id],
        );
      if (mode === "revoked")
        await cli.manageRegistrationInvitations(
          owner,
          { action: "revoke", id: invitation.id },
          "production",
        );
      const userId = opaque("user");
      if (mode === "existing")
        await adapter.transaction((tx) =>
          insertRegistration(tx, invitation.id, userId),
        );
      const outcome = await adapter.transaction(async (tx) => {
        const proof =
          mode === "existing"
            ? { at: new Date().toISOString(), handoffId: opaque("handoff") }
            : await insertRegistration(tx, invitation.id, userId, {
                environment:
                  mode === "environment" ? "development" : "production",
                consumed: mode === "consumed",
                invitation: mode !== "absent",
              });
        return tx.redeemInvitation(
          invitation.id,
          userId,
          proof.at,
          mode === "wrong-handoff" ? opaque("handoff") : proof.handoffId,
        );
      });
      expect(outcome).toBe(false);
      expect(await access.read(userId)).toBe("none");
    }
  });
  it("cannot turn an updated existing account into a new registration grant", async () => {
    const invitation = await create();
    const userId = opaque("user");
    await owner.query(
      `INSERT INTO community.public_users(id,handle,display_name,created_at)
      VALUES($1,$2,'Synthetic existing account',now()-interval '1 day')`,
      [userId, `synthetic-${randomBytes(5).toString("hex")}`],
    );
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE community.public_users SET display_name='Synthetic updated account' WHERE id=$1",
        [userId],
      );
      const targetDigest = digest();
      const handoffId = opaque("handoff");
      await client.query(
        `INSERT INTO community.user_login_identities
        (id,user_id,kind,lookup_digest,ciphertext,lookup_key_version,verification_mode,environment,version,verified_at)
        VALUES($1,$2,'email',$3,'synthetic-encrypted-fixture',1,'provider','production',1,now())`,
        [opaque("login"), userId, targetDigest],
      );
      await client.query(
        `INSERT INTO community.auth_handoffs
        (id,token_hash,purpose,channel,target_digest,ciphertext,provider_mode,environment,expires_at,invitation_id)
        VALUES($1,$2,'register_confirm','email',$3,'synthetic-encrypted-fixture','provider','production',now()+interval '5 minutes',$4)`,
        [handoffId, digest(), targetDigest, invitation.id],
      );
      expect(
        (
          await client.query(
            "SELECT community.redeem_registration_invitation($1,$2,now(),$3) AS granted",
            [invitation.id, userId, handoffId],
          )
        ).rows[0]?.granted,
      ).toBe(false);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await access.read(userId)).toBe("none");
  });
  it("reports any admission database error as store unavailable", async () => {
    const broken = createPostgresBetaAccountAccess({
      query: async () => {
        throw Error("Synthetic failure");
      },
    } as unknown as typeof app);
    await expect(broken.read(opaque("user"))).rejects.toBeInstanceOf(
      CommunityStoreUnavailableError,
    );
  });
});
