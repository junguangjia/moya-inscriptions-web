import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProductionAuthService } from "@moya/api";
import type { CommunityAuthPort, AuthPurposeName } from "@moya/api";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresCommunityAuthAdapter,
  runCommunityMigrations,
  verifyCommunityMigrationLedger,
} from "@moya/community-postgres";
import {
  createProductionAuthDelivery,
  loadProductionAuthConfiguration,
} from "@moya/backend-production/internal/auth";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

// Every contact, key, invitation, code and user in this suite is synthetic.
// ProviderTransport is a PNVS fixture; this suite never opens an external API.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const migrations = join(root, "database/community-migrations");
const migration = "20261026020000";
const signature =
  "community.redeem_registration_invitation(text,text,timestamp with time zone,text)";
const sharedUrl = requireSyntheticTestDatabaseUrl();
const suffix = randomBytes(5).toString("hex");
const database = `pnvs_invitation_${suffix}_synthetic_test`;
const role = `pnvs_inv_app_${suffix}`;
const ownerUrl = new URL(sharedUrl);
ownerUrl.pathname = `/${database}`;
const appUrl = new URL(ownerUrl);
appUrl.username = role;
appUrl.password = "synthetic-pnvs-test-only";
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
const keys = {
  AUTH_KEY_VERSION: "1",
  AUTH_LOOKUP_KEY: randomBytes(32).toString("base64"),
  AUTH_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  AUTH_OTP_KEY: randomBytes(32).toString("base64"),
};
const agreement = {
  version: "synthetic-pnvs-pg-v1",
  title: "Synthetic acceptance",
  body: "Isolated PostgreSQL acceptance only.",
};
let sequence = 100;
const nextPhone = () => `+86138${String(sequence++).padStart(8, "0")}`;
const opaque = (prefix: string) =>
  `${prefix}-${randomBytes(16).toString("hex")}`;
const digest = () => randomBytes(32).toString("hex");
const newInvitation = async (maxUses = 2) => {
  const code = randomBytes(16).toString("base64url");
  const id = opaque("invitation");
  await owner.query(
    "INSERT INTO community.registration_invitations(id,digest,environment,max_uses,expires_at) VALUES($1,$2,'production',$3,now()+interval '1 day')",
    [
      id,
      createHash("sha256")
        .update(`artvenn:registration-invitation:v1:${code}`)
        .digest("hex"),
      maxUses,
    ],
  );
  return { id, code };
};
const invitationState = async (id: string) =>
  (
    await owner.query<{
      used: number;
      redemptions: number;
      grants: number;
      consumed: number;
    }>(
      `SELECT used_count AS used,
  (SELECT count(*)::integer FROM community.registration_invitation_redemptions WHERE invitation_id=$1) AS redemptions,
  (SELECT count(*)::integer FROM community.beta_account_access WHERE invitation_id=$1 AND state='granted') AS grants,
  (SELECT count(*)::integer FROM community.auth_handoffs WHERE invitation_id=$1 AND consumed_at IS NOT NULL) AS consumed
  FROM community.registration_invitations WHERE id=$1`,
      [id],
    )
  ).rows[0];

const harness = async (port: CommunityAuthPort = adapter) => {
  const config = await loadProductionAuthConfiguration({
    ...keys,
    NODE_ENV: "production",
    AUTH_PUBLIC_ENABLED: "true",
    AUTH_PROFILE: "email-first",
    AUTH_EMAIL_PROVIDER: "disabled",
    AUTH_PHONE_PROVIDER: "aliyun-dypns",
    AUTH_REGISTRATION_MODE: "invite-only",
    ALIYUN_ACCESS_KEY_ID: "SYNTHETIC_ONLY",
    ALIYUN_ACCESS_KEY_SECRET: "SYNTHETIC_ONLY",
    ALIYUN_SMS_SIGN_NAME: "Synthetic",
    ALIYUN_SMS_TEMPLATE_CODE: "100001",
    ALIYUN_SMS_SCHEME_NAME: "synthetic-pnvs-pg",
  });
  if (config === null) throw Error("Synthetic config missing");
  const messages = new Map<string, string>();
  const providerCodes = new Map<string, string>();
  let calls = 0,
    checks = 0;
  let barrier: (() => Promise<void>) | undefined;
  const delivery = createProductionAuthDelivery(config, {
    transport: async (request) => {
      const form = new URLSearchParams(request.body);
      const key = `${form.get("PhoneNumber")}:${form.get("SchemeName")}`;
      if (request.headers["x-acs-action"] === "SendSmsVerifyCode") {
        calls++;
        const code = String(100000 + calls);
        messages.set(form.get("OutId")!, code);
        providerCodes.set(key, code);
        return {
          status: 200,
          body: JSON.stringify({
            Code: "OK",
            Success: true,
            Model: { BizId: "synthetic-pg-message" },
          }),
        };
      }
      checks++;
      const pass = providerCodes.get(key) === form.get("VerifyCode");
      if (pass) {
        await barrier?.();
        providerCodes.delete(key);
      }
      return {
        status: 200,
        body: JSON.stringify({
          Code: "OK",
          Success: true,
          Model: { VerifyResult: pass ? "PASS" : "UNKNOWN" },
        }),
      };
    },
  });
  const service = createProductionAuthService(
    port,
    config.service,
    delivery,
    agreement,
  );
  const send = async (
    phone: string,
    purpose: AuthPurposeName,
    extra: {
      invitationCode?: string;
      sessionToken?: string;
      reauthToken?: string;
    } = {},
  ) => {
    const result = await service.sendChallenge({
      channel: "phone",
      purpose,
      identifier: phone,
      idempotencyKey: randomUUID(),
      source: `synthetic-${suffix}-${sequence++}`,
      ...extra,
    });
    if (!result.ok || result.value.continuationToken === undefined)
      throw Error("Synthetic challenge refused");
    const code = messages.get(result.value.challengeId);
    if (code === undefined) throw Error("Synthetic delivery missing");
    return {
      challengeId: result.value.challengeId,
      continuationToken: result.value.continuationToken,
      code,
      idempotencyKey: randomUUID(),
    };
  };
  const prepare = async (phone: string, invitationCode: string) => {
    const proof = await service.verifyChallenge(
      await send(phone, "register", { invitationCode }),
    );
    if (!proof.ok || proof.value.outcome !== "registration_required")
      throw Error("Synthetic phone proof refused");
    return {
      handoffToken: proof.value.handoffToken,
      displayName: "Synthetic PNVS",
      agreement: true,
      agreementVersion: agreement.version,
      idempotencyKey: randomUUID(),
    };
  };
  const register = async (phone: string, invitationCode: string) => {
    const result = await service.confirmRegistration(
      await prepare(phone, invitationCode),
    );
    if (!result.ok) throw Error("Synthetic registration refused");
    return result.value;
  };
  return {
    service,
    send,
    prepare,
    register,
    calls: () => calls,
    checks: () => checks,
    barrier: () => {
      let arrived = 0;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      barrier = async () => {
        arrived++;
        if (arrived === 2) release();
        await ready;
      };
    },
  };
};

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  await owner.query(
    `COMMENT ON DATABASE ${database} IS 'yoyi-disposable-test-target'`,
  );
  await runCommunityMigrations(owner, migrations, {
    through: "20261026010000",
  });
  await owner.query(
    "CREATE TABLE public.catalog_entries(catalog_id text,province text,province_state text); CREATE TABLE public.catalog_discovery(catalog_id text); CREATE TABLE public.catalog_media(catalog_id text); CREATE TABLE public.article_entries(article_id text);",
  );
  await owner.query(
    `CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-pnvs-test-only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );
  await owner.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
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
  await admin.query(`DROP DATABASE IF EXISTS ${database}`);
  await admin.query(`DROP ROLE IF EXISTS ${role}`);
  await admin.end();
});

describe("Production PNVS invitation registration on PostgreSQL", () => {
  it("reproduces the prior phone refusal, then upgrades without changing function/grant authority", async () => {
    const h = await harness();
    const invitation = await newInvitation();
    await expect(
      h.service.sendChallenge({
        channel: "phone",
        purpose: "register",
        identifier: nextPhone(),
        invitationCode: invitation.code,
        idempotencyKey: randomUUID(),
        source: "synthetic-baseline",
      }),
    ).rejects.toThrow();
    expect(h.calls()).toBe(0);
    await expect(verifyCommunityMigrationLedger(app)).rejects.toThrow();
    const authority = async () =>
      (
        await owner.query(
          "SELECT oid::text AS identity,proowner::text AS owner,proacl::text AS acl,prosecdef AS definer,proconfig AS settings FROM pg_proc WHERE oid=$1::regprocedure",
          [signature],
        )
      ).rows[0];
    const before = await authority();
    expect(await runCommunityMigrations(owner, migrations)).toEqual([
      migration,
    ]);
    expect(await authority()).toEqual(before);
    expect(before.definer).toBe(true);
    expect(before.settings).toEqual(["search_path=pg_catalog, community"]);
    await verifyCommunityMigrationLedger(app);
    const publicPermission = await owner.query(
      "SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed",
      [signature],
    );
    expect(publicPermission.rows[0]?.allowed).toBe(false);
    const grants = await app.query(
      "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS execute,has_table_privilege(current_user,'community.registration_invitations','UPDATE') AS invitation_update,has_table_privilege(current_user,'community.beta_account_access','INSERT') AS beta_insert",
      [signature],
    );
    expect(grants.rows[0]).toEqual({
      execute: true,
      invitation_update: false,
      beta_insert: false,
    });
  });

  it("completes phone invitation registration, grants beta once, and signs in to the same user", async () => {
    const h = await harness();
    const invitation = await newInvitation();
    const phone = nextPhone();
    const account = await h.register(phone, invitation.code);
    expect(await invitationState(invitation.id)).toEqual({
      used: 1,
      redemptions: 1,
      grants: 1,
      consumed: 1,
    });
    const result = await h.service.verifyChallenge(
      await h.send(phone, "sign_in"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.outcome !== "signed_in")
      throw Error("Synthetic sign-in refused");
    expect(result.value.session.profile.id).toBe(account.profile.id);
    const state = await h.service.readAccount(result.value.session.token);
    expect(state.ok && state.value.phone.usable).toBe(true);
    const identities = await app.query(
      "SELECT user_id,kind,verification_mode,environment FROM community.user_login_identities WHERE user_id=$1",
      [account.profile.id],
    );
    expect(identities.rows).toEqual([
      {
        user_id: account.profile.id,
        kind: "phone",
        verification_mode: "provider",
        environment: "production",
      },
    ]);
    expect(await invitationState(invitation.id)).toEqual({
      used: 1,
      redemptions: 1,
      grants: 1,
      consumed: 1,
    });
  });

  it("admits one handoff after two provider PASS results and consumes it once", async () => {
    const h = await harness();
    const invitation = await newInvitation(1);
    const phone = nextPhone();
    const input = await h.send(phone, "register", {
      invitationCode: invitation.code,
    });
    h.barrier();
    const results = await Promise.all([
      h.service.verifyChallenge(input),
      h.service.verifyChallenge({ ...input, idempotencyKey: randomUUID() }),
    ]);
    expect(h.checks()).toBe(2);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const winner = results.find((result) => result.ok);
    if (!winner?.ok || winner.value.outcome !== "registration_required")
      throw Error("Synthetic winner missing");
    const request = {
      handoffToken: winner.value.handoffToken,
      displayName: "Synthetic race",
      agreement: true,
      agreementVersion: agreement.version,
      idempotencyKey: randomUUID(),
    };
    const confirms = await Promise.all([
      h.service.confirmRegistration(request),
      h.service.confirmRegistration({
        ...request,
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(confirms.filter((result) => result.ok)).toHaveLength(1);
    expect(await invitationState(invitation.id)).toEqual({
      used: 1,
      redemptions: 1,
      grants: 1,
      consumed: 1,
    });
    const handoffs = await app.query(
      "SELECT count(*)::integer AS total FROM community.auth_handoffs WHERE invitation_id=$1",
      [invitation.id],
    );
    expect(handoffs.rows[0]?.total).toBe(1);
  });

  it("serializes different verified phones competing for the last invitation slot", async () => {
    const h = await harness();
    const invitation = await newInvitation(1);
    const first = await h.prepare(nextPhone(), invitation.code);
    const second = await h.prepare(nextPhone(), invitation.code);
    const results = await Promise.all([
      h.service.confirmRegistration(first),
      h.service.confirmRegistration(second),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await invitationState(invitation.id)).toEqual({
      used: 1,
      redemptions: 1,
      grants: 1,
      consumed: 1,
    });
  });

  it("keeps an already owned phone on its account when another account tries to replace its factor", async () => {
    const h = await harness();
    const invitation = await newInvitation();
    const firstPhone = nextPhone();
    const secondPhone = nextPhone();
    const first = await h.register(firstPhone, invitation.code);
    const second = await h.register(secondPhone, invitation.code);
    const reauth = await h.service.verifyChallenge(
      await h.send(secondPhone, "reauthenticate", {
        sessionToken: second.token,
      }),
    );
    if (!reauth.ok || reauth.value.outcome !== "reauthenticated")
      throw Error("Synthetic reauth refused");
    const change = await h.send(firstPhone, "replace", {
      sessionToken: second.token,
      reauthToken: reauth.value.reauthToken,
    });
    const checks = h.checks();
    expect(
      await h.service.completeFactor({
        ...change,
        sessionToken: second.token,
        reauthToken: reauth.value.reauthToken,
        expectedVersion: 1,
      }),
    ).toEqual({ ok: false, reason: "AUTH_IDENTIFIER_CONFLICT" });
    expect(h.checks()).toBe(checks);
    const state = await h.service.readAccount(first.token);
    expect(state.ok && state.value.userId).toBe(first.profile.id);
    expect(state.ok && state.value.phone.usable).toBe(true);
    expect(await invitationState(invitation.id)).toEqual({
      used: 2,
      redemptions: 2,
      grants: 2,
      consumed: 2,
    });
  });

  it("rolls back account, identity, quota and grant if handoff consumption fails after redemption", async () => {
    const h = await harness({
      transaction: (work) =>
        adapter.transaction((tx) =>
          work({ ...tx, consumeHandoff: async () => "consumed" }),
        ),
    });
    const invitation = await newInvitation();
    const before = await adapter.transaction((tx) => tx.countUsers());
    expect(
      await h.service.confirmRegistration(
        await h.prepare(nextPhone(), invitation.code),
      ),
    ).toEqual({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    expect(await adapter.transaction((tx) => tx.countUsers())).toBe(before);
    expect(await invitationState(invitation.id)).toEqual({
      used: 0,
      redemptions: 0,
      grants: 0,
      consumed: 0,
    });
  });

  it("rejects a phone identity paired with an email handoff even when the digest is identical", async () => {
    const invitation = await newInvitation();
    let rejected = false;
    await expect(
      adapter.transaction(async (tx) => {
        const userId = opaque("user"),
          targetDigest = digest(),
          now = new Date();
        await tx.insertUser({
          id: userId,
          handle: `synthetic-${randomBytes(5).toString("hex")}`,
          displayName: "Synthetic mismatch",
          status: "active",
        });
        await tx.insertIdentity({
          id: opaque("login"),
          userId,
          kind: "phone",
          lookupDigest: targetDigest,
          ciphertext: "synthetic-encrypted-fixture",
          lookupKeyVersion: 1,
          verificationMode: "provider",
          environment: "production",
          version: 1,
          verifiedAt: now.toISOString(),
        });
        const handoffId = opaque("handoff");
        await tx.insertHandoff({
          id: handoffId,
          tokenHash: digest(),
          purpose: "register_confirm",
          channel: "email",
          targetDigest,
          ciphertext: "synthetic-encrypted-fixture",
          providerMode: "provider",
          environment: "production",
          userId: null,
          sessionHash: null,
          expectedVersion: null,
          invitationId: invitation.id,
          expiresAt: new Date(now.getTime() + 300000).toISOString(),
          consumedAt: null,
        });
        rejected = !(await tx.redeemInvitation(
          invitation.id,
          userId,
          now.toISOString(),
          handoffId,
        ));
        throw Error("Synthetic mismatch rollback");
      }),
    ).rejects.toThrow("Synthetic mismatch rollback");
    expect(rejected).toBe(true);
    expect(await invitationState(invitation.id)).toEqual({
      used: 0,
      redemptions: 0,
      grants: 0,
      consumed: 0,
    });
  });
});
