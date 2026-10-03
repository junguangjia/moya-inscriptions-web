import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CommunityAuthService, createMemoryCommunityAuthPort } from "@moya/api";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresCommunityAuthAdapter,
  runCommunityMigrations,
  verifyCommunityMigrationLedger,
} from "@moya/community-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertSyntheticTestDatabaseUrl,
  requireSyntheticTestDatabaseUrl,
} from "./synthetic-test-database.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = `${root}/database/community-migrations`;
const baseline = "20261001020000";
const forward = "20261002010000";
const constraint = "community.user_login_identities_one_lookup_key_version";
const parentUrl = requireSyntheticTestDatabaseUrl();
const name = `login_rotation_${randomBytes(6).toString("hex")}_synthetic_test`;
const url = new URL(parentUrl);
url.pathname = `/${name}`;
assertSyntheticTestDatabaseUrl(url.toString());
const admin = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: parentUrl }),
);
const pool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: url.toString() }),
);
const user = (n: number) => `user-${String(n).padStart(32, "0")}`;
const identity = (n: number) => `login-${String(n).padStart(32, "0")}`;
const keys = (version: number) => ({
  version,
  lookupKey: Buffer.alloc(32, version),
  encryptionKey: Buffer.alloc(32, 11),
  otpKey: Buffer.alloc(32, 12),
});
const insertSql = `INSERT INTO community.user_login_identities
 (id,user_id,kind,lookup_digest,ciphertext,lookup_key_version,verification_mode,environment,version,verified_at)
 VALUES($1,$2,'email',$3,$4,$5,'local_capture','development',1,'2026-10-01T00:00:00Z')`;
const serviceOptions = (
  version: number,
  sendEmail: (input: { to: string; code: string }) => void,
) => ({
  environment: "development" as const,
  profile: "email-first" as const,
  keys: keys(version),
  emailMode: "local_capture" as const,
  phoneMode: "disabled" as const,
  delivery: {
    sendEmail: async (input: { to: string; code: string }) => {
      sendEmail(input);
      return { state: "accepted" as const, correlation: "synthetic-rotation" };
    },
    sendPhone: async () => ({ state: "failed" as const, correlation: null }),
    checkPhone: async () => "fail" as const,
  },
});
// Generate stored envelopes through the public auth interface, keeping this
// database test independent of private API source and crypto implementation.
const values = async (n: number, version = 1) => {
  const port = createMemoryCommunityAuthPort();
  const service = new CommunityAuthService(
    port,
    serviceOptions(version, () => {}),
  );
  const sent = await service.sendChallenge({
    channel: "email",
    purpose: "register",
    identifier: `Synthetic-${n}@example.invalid`,
    idempotencyKey: randomUUID(),
    source: "127.0.0.1",
  });
  if (!sent.ok) throw new Error(sent.reason);
  const challenge = await port.transaction((tx) =>
    tx.findChallenge(sent.value.challengeId),
  );
  if (challenge === null) throw new Error("missing synthetic challenge");
  return [
    identity(n),
    user(n),
    challenge.targetDigest,
    challenge.ciphertext,
    version,
  ];
};
const rows = async () =>
  (
    await pool.query(
      "SELECT * FROM community.user_login_identities ORDER BY id",
    )
  ).rows;
const ledger = async () =>
  (
    await pool.query(
      "SELECT * FROM community.schema_migrations ORDER BY migration_id",
    )
  ).rows;

beforeAll(async () => {
  const guard = await import(
    new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
  );
  guard.assertDisposableTestTarget(
    (await admin.query(guard.disposableTestTargetProbeSql)).rows,
    new URL(parentUrl).pathname.slice(1),
  );
  await admin.query(`CREATE DATABASE ${name}`);
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
});
beforeEach(async () => {
  await pool.query("DROP SCHEMA IF EXISTS community CASCADE");
  await runCommunityMigrations(pool, directory, { through: baseline });
  await pool.query(
    `INSERT INTO community.public_users(id,handle,display_name) VALUES($1,'rotation-one','Synthetic'),($2,'rotation-two','Synthetic')`,
    [user(1), user(2)],
  );
});

describe("login lookup-key rotation and lifecycle", () => {
  it("reproduces the old bulk-rotation failure, then upgrades without rewriting identity or ledger history", async () => {
    await pool.query(insertSql, await values(1));
    await pool.query(insertSql, await values(2));
    const original = await rows();
    const originalLedger = await ledger();
    await expect(
      pool.query(
        "UPDATE community.user_login_identities SET lookup_key_version=2",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await rows()).toEqual(original);
    expect(await runCommunityMigrations(pool, directory)).toEqual([
      forward,
      "20261002020000",
      "20261003010000",
    ]);
    expect((await ledger()).slice(0, originalLedger.length)).toEqual(
      originalLedger,
    );
    expect(await rows()).toEqual(original);
    expect(await runCommunityMigrations(pool, directory)).toEqual([]);
    await verifyCommunityMigrationLedger(pool);
    const replacements = await Promise.all([1, 2].map((n) => values(n, 2)));
    await pool.query(
      `UPDATE community.user_login_identities SET lookup_key_version=2,
      lookup_digest=CASE id WHEN $1 THEN $2 ELSE $3 END,
      ciphertext=CASE id WHEN $1 THEN $4 ELSE $5 END`,
      [
        identity(1),
        replacements[0]![2],
        replacements[1]![2],
        replacements[0]![3],
        replacements[1]![3],
      ],
    );
    const rotated = await rows();
    for (const [i, row] of rotated.entries()) {
      const rotatedColumns = [
        "lookup_key_version",
        "lookup_digest",
        "ciphertext",
      ];
      for (const column of Object.keys(original[i])) {
        if (!rotatedColumns.includes(column))
          expect(row[column]).toEqual(original[i][column]);
      }
      expect(row.lookup_key_version).toBe(2);
      expect(row.lookup_digest).toBe(replacements[i]![2]);
      let delivered = { to: "", code: "" };
      const service = new CommunityAuthService(
        new PostgresCommunityAuthAdapter(pool),
        serviceOptions(2, (input) => {
          delivered = input;
        }),
      );
      const sent = await service.sendChallenge({
        channel: "email",
        purpose: "sign_in",
        identifier: `synthetic-${i + 1}@example.invalid`,
        idempotencyKey: randomUUID(),
        source: "127.0.0.1",
      });
      if (!sent.ok || sent.value.continuationToken === undefined)
        throw new Error("rotated sign-in challenge failed");
      const signed = await service.verifyChallenge({
        challengeId: sent.value.challengeId,
        code: delivered.code,
        continuationToken: sent.value.continuationToken,
        idempotencyKey: randomUUID(),
      });
      if (!signed.ok || signed.value.outcome !== "signed_in")
        throw new Error("rotated contact lookup failed");
      expect(signed.value.session.profile.id).toBe(user(i + 1));
      expect(
        (
          await service.sendChallenge({
            channel: "email",
            purpose: "reauthenticate",
            sessionToken: signed.value.session.token,
            idempotencyKey: randomUUID(),
            source: "127.0.0.1",
          })
        ).ok,
      ).toBe(true);
      expect(delivered.to).toBe(`Synthetic-${i + 1}@example.invalid`);
    }
    await expect(
      pool.query(
        "UPDATE community.user_login_identities SET lookup_digest=$1 WHERE id=$2",
        [rotated[0].lookup_digest, identity(2)],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("supports explicitly deferred rotation, rejects partial rotation, and preserves adapter conflict semantics", async () => {
    await runCommunityMigrations(pool, directory);
    await pool.query(insertSql, await values(1));
    await pool.query(insertSql, await values(2));
    await expect(
      pool.query(
        "UPDATE community.user_login_identities SET lookup_key_version=2 WHERE id=$1",
        [identity(1)],
      ),
    ).rejects.toMatchObject({ code: "23P01" });
    const adapter = new PostgresCommunityAuthAdapter(pool);
    await expect(
      adapter.transaction(async (tx) => {
        const current = (await tx.listIdentities(user(1)))[0]!;
        return tx.replaceIdentity({ ...current, lookupKeyVersion: 2 }, 1);
      }),
    ).resolves.toBe("conflict");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET CONSTRAINTS ${constraint} DEFERRED`);
      await client.query(
        "UPDATE community.user_login_identities SET lookup_key_version=2 WHERE id=$1",
        [identity(1)],
      );
      await expect(
        client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`),
      ).rejects.toMatchObject({ code: "23P01" });
      await client.query("ROLLBACK");
      expect((await rows()).map((r) => r.lookup_key_version)).toEqual([1, 1]);
      await client.query("BEGIN");
      await client.query(`SET CONSTRAINTS ${constraint} DEFERRED`);
      for (const n of [1, 2]) {
        const v = await values(n, 2);
        await client.query(
          "UPDATE community.user_login_identities SET lookup_key_version=2,lookup_digest=$1,ciphertext=$2 WHERE id=$3",
          [v[2], v[3], identity(n)],
        );
      }
      await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`);
      await client.query("COMMIT");
      expect((await rows()).map((r) => r.lookup_key_version)).toEqual([2, 2]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it.each(["READ COMMITTED", "REPEATABLE READ"])(
    "rejects racing mixed first writes under %s, including a stale snapshot",
    async (isolation) => {
      await runCommunityMigrations(pool, directory);
      const a = await pool.connect(),
        b = await pool.connect();
      try {
        await a.query("BEGIN");
        await b.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        await b.query("SELECT count(*) FROM community.user_login_identities");
        await a.query(insertSql, await values(1));
        const waiting = b.query(insertSql, await values(2, 2)).then(
          () => "accepted",
          (error: { code: string }) => error.code,
        );
        await a.query("COMMIT");
        expect(await waiting).toBe("23P01");
        await b.query("ROLLBACK");
        expect((await rows()).map((r) => r.lookup_key_version)).toEqual([1]);
        await b.query(insertSql, await values(2));
        expect((await rows()).map((r) => r.lookup_key_version)).toEqual([1, 1]);
      } finally {
        await a.query("ROLLBACK");
        await b.query("ROLLBACK");
        a.release();
        b.release();
      }
    },
  );

  it("refuses a historically mixed-version upgrade atomically without rewriting data", async () => {
    const a = await pool.connect(),
      b = await pool.connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      await a.query(insertSql, await values(1));
      await b.query(insertSql, await values(2, 2));
      await a.query("COMMIT");
      await b.query("COMMIT");
    } finally {
      a.release();
      b.release();
    }
    const before = await rows(),
      beforeLedger = await ledger();
    await expect(runCommunityMigrations(pool, directory)).rejects.toMatchObject(
      { name: "CommunityMigrationStateError" },
    );
    expect(await rows()).toEqual(before);
    expect(await ledger()).toEqual(beforeLedger);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM pg_trigger WHERE tgname='user_login_identities_one_lookup_key_version' AND NOT tgisinternal",
        )
      ).rowCount,
    ).toBe(1);
  });

  it("preserves last-factor protection and the existing suspension contract; owner CASCADE is not account closing", async () => {
    await runCommunityMigrations(pool, directory);
    await pool.query(insertSql, await values(1));
    await expect(
      pool.query("DELETE FROM community.public_users WHERE id=$1", [user(1)]),
    ).rejects.toMatchObject({ code: "23514", message: "last login identity" });
    const adapter = new PostgresCommunityAuthAdapter(pool);
    await expect(
      adapter.transaction((tx) => tx.deleteIdentity(user(1), "email", 1)),
    ).resolves.toBe("last_factor");
    await pool.query(
      "UPDATE community.public_users SET status='suspended' WHERE id=$1",
      [user(1)],
    );
    expect(await rows()).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT status FROM community.public_users WHERE id=$1",
          [user(1)],
        )
      ).rows[0].status,
    ).toBe("suspended");
  });
});
