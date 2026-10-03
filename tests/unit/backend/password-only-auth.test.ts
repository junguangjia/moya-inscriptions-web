import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { publicUserDisplayNameSchema } from "@moya/contracts/schemas";
import {
  CommunityAuthService,
  createMemoryCommunityAuthPort,
  hashPassword,
  productionAuthConfigurationFrom,
} from "@moya/api";
import type { CommunityAuthPort, StoredSession } from "@moya/api";
import {
  loadProductionAuthConfiguration,
  createConfiguredProductionAuthService,
} from "@moya/backend-production/internal/auth";

const syntheticPassword = "SyntheticA1!";
const user = {
  id: `user-${"a".repeat(32)}`,
  handle: "synthetic-operator",
  displayName: "合成账号",
  status: "active" as const,
};
const keys = {
  version: 1,
  lookupKey: randomBytes(32),
  encryptionKey: randomBytes(32),
  otpKey: randomBytes(32),
};
const environment = () => ({
  NODE_ENV: "production",
  AUTH_PUBLIC_ENABLED: "true",
  AUTH_PROFILE: "password-only",
  AUTH_EMAIL_PROVIDER: "disabled",
  AUTH_PHONE_PROVIDER: "disabled",
  AUTH_KEY_VERSION: "1",
  AUTH_LOOKUP_KEY: Buffer.from(keys.lookupKey).toString("base64"),
  AUTH_ENCRYPTION_KEY: Buffer.from(keys.encryptionKey).toString("base64"),
  AUTH_OTP_KEY: Buffer.from(keys.otpKey).toString("base64"),
});
const harness = async () => {
  const port = createMemoryCommunityAuthPort();
  port.provisionPasswordAccount(
    user,
    {
      userId: user.id,
      verifier: await hashPassword(syntheticPassword),
      version: 1,
      updatedAt: new Date().toISOString(),
    },
    "production",
  );
  const sessions: StoredSession[] = [];
  const recording: CommunityAuthPort = {
    transaction: (work) =>
      port.transaction((tx) =>
        work({
          ...tx,
          insertSession: async (row) => {
            sessions.push(row);
            await tx.insertSession(row);
          },
        }),
      ),
  };
  const transport = vi.fn(async () => {
    throw new Error("Delivery must not run");
  });
  const config = await loadProductionAuthConfiguration(environment());
  if (!config) throw new Error("Synthetic configuration required");
  return {
    port,
    sessions,
    transport,
    service: createConfiguredProductionAuthService(recording, config, {
      transport,
    }),
  };
};
const login = (identifier = user.handle) => ({
  channel: "handle" as const,
  identifier,
  password: syntheticPassword,
  idempotencyKey: randomUUID(),
  source: "synthetic",
});

describe("Production password-only controlled authentication", () => {
  it("requires explicit disabled OTP providers and no delivery configuration", async () => {
    const config = await loadProductionAuthConfiguration(environment());
    expect(config).toMatchObject({
      email: null,
      phone: null,
      agreement: null,
      service: { profile: "password-only" },
    });
    for (const delta of [
      { AUTH_EMAIL_PROVIDER: "tencent-ses" },
      { AUTH_PHONE_PROVIDER: "aliyun-dypns" },
      { TENCENT_SES_FROM: "synthetic@example.invalid" },
      { AUTH_EMAIL_CAPTURE_URL: "http://localhost:3463" },
    ])
      expect(() =>
        productionAuthConfigurationFrom({ ...environment(), ...delta }),
      ).toThrow();
  });

  it("logs in with truthful provenance and unbound contacts; receipt reissue and logout stay sealed", async () => {
    const h = await harness();
    expect(h.service.capabilities()).toMatchObject({
      profile: "password-only",
      password: { available: true, identifiers: ["handle"] },
      email: { available: false },
      phone: { available: false },
      registration: { available: false },
    });
    const request = login();
    const signed = await h.service.passwordLogin(request);
    if (!signed.ok) throw new Error(signed.reason);
    expect(signed.value.profile.id).toBe(user.id);
    expect(h.sessions[0]).toMatchObject({
      issuer: "password_login",
      authChannel: null,
      authEnvironment: "production",
    });
    expect(await h.service.readAccount(signed.value.token)).toMatchObject({
      ok: true,
      value: {
        email: { state: "unbound", masked: null, version: 0 },
        phone: { state: "unbound", masked: null, version: 0 },
      },
    });
    const retry = await h.service.passwordLogin(request);
    if (!retry.ok) throw new Error(retry.reason);
    expect(retry.value.token).not.toBe(signed.value.token);
    expect(await h.service.readAccount(signed.value.token)).toMatchObject({
      ok: false,
    });
    await h.service.signOut(retry.value.token);
    expect(await h.service.passwordLogin(request)).toEqual({
      ok: false,
      reason: "AUTH_PROOF_REJECTED",
    });
    expect(await h.service.readAccount(retry.value.token)).toMatchObject({
      ok: false,
    });
    expect(h.transport).not.toHaveBeenCalled();
  });

  it("refuses unprovisioned, wrong-password, suspended, environment and changed-credential accounts generically", async () => {
    const h = await harness();
    const denied = { ok: false, reason: "AUTH_INVALID_CREDENTIALS" };
    expect(await h.service.passwordLogin(login("unknown-handle"))).toEqual(
      denied,
    );
    expect(
      await h.service.passwordLogin({
        ...login(),
        password: randomBytes(24).toString("hex"),
      }),
    ).toEqual(denied);
    h.port.setStatus(user.id, "suspended");
    expect(await h.service.passwordLogin(login())).toEqual(denied);
    h.port.setStatus(user.id, "active");
    await h.port.transaction(async (tx) => {
      const c = await tx.findPasswordCredential(user.id);
      if (!c) throw Error();
      await tx.savePasswordCredential(
        { ...c, verifier: await hashPassword(syntheticPassword) },
        c.version,
      );
    });
    expect(await h.service.passwordLogin(login())).toEqual(denied);
    await h.port.transaction(async (tx) => {
      await tx.insertUser({
        ...user,
        id: `user-${"b".repeat(32)}`,
        handle: "app-created",
      });
      await tx.savePasswordCredential(
        {
          userId: `user-${"b".repeat(32)}`,
          verifier: await hashPassword(syntheticPassword),
          version: 1,
          updatedAt: new Date().toISOString(),
        },
        null,
      );
    });
    expect(await h.service.passwordLogin(login("app-created"))).toEqual(denied);
    expect(h.sessions).toHaveLength(0);
  });

  it("rejects all OTP-dependent paths before consulting stale proofs or receipts", async () => {
    const transaction = vi.fn(async () => {
      throw new Error("OTP persistence must not run");
    });
    const config = await loadProductionAuthConfiguration(environment());
    if (!config) throw Error();
    const service = createConfiguredProductionAuthService(
      { transaction },
      config,
    );
    const proof = randomBytes(32).toString("base64url");
    const common = {
      challengeId: `challenge-${"b".repeat(32)}`,
      code: "123456",
      continuationToken: proof,
      idempotencyKey: randomUUID(),
      reauthToken: proof,
      expectedVersion: 1,
      sessionToken: proof,
    };
    expect(
      await service.sendChallenge({
        channel: "email",
        purpose: "sign_in",
        identifier: "synthetic@example.invalid",
        idempotencyKey: randomUUID(),
        source: "synthetic",
      }),
    ).toMatchObject({ ok: false, reason: "AUTH_CHANNEL_UNAVAILABLE" });
    for (const result of [
      await service.verifyChallenge(common),
      await service.resetPassword({
        handoffToken: proof,
        password: syntheticPassword,
        idempotencyKey: randomUUID(),
      }),
      await service.completeFactor(common),
      await service.unlinkFactor({ ...common, channel: "phone" }),
      await service.confirmRegistration({
        handoffToken: proof,
        displayName: "合成",
        agreement: true,
        idempotencyKey: randomUUID(),
      }),
    ])
      expect(result.ok).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("keeps source/target throttling and environment isolation", async () => {
    const h = await harness();
    let result;
    for (let i = 0; i < 12; i++)
      result = await h.service.passwordLogin({
        ...login(),
        password: randomBytes(24).toString("hex"),
      });
    expect(result).toMatchObject({ ok: false, reason: "AUTH_RATE_LIMITED" });
    const isolated = await harness();
    const other = new CommunityAuthService(isolated.port, {
      environment: "development",
      profile: "password-only",
      keys,
      emailMode: "disabled",
      phoneMode: "disabled",
      delivery: {
        sendEmail: async () => ({ state: "failed" }),
        sendPhone: async () => ({ state: "failed" }),
        checkPhone: async () => "fail",
      },
    });
    expect(
      await other.passwordLogin({ ...login(), source: "other" }),
    ).toMatchObject({ ok: false });
    expect(
      await h.port.transaction((tx) =>
        tx.findSessionUser(
          "0".repeat(64),
          new Date().toISOString(),
          "production",
        ),
      ),
    ).toBeNull();
  });
});

it.each(["😀", "𠮷"])(
  "keeps operator display names compatible with public profiles for %s",
  async (character) => {
    const setup = await import(
      new URL(
        "../../../scripts/provision-password-account.mjs",
        import.meta.url,
      ).href
    );
    const input = {
      requestId: randomUUID(),
      handle: "synthetic-unicode",
      displayName: character.repeat(20),
      environment: "production",
      operatorLabel: "synthetic-operator",
      password: syntheticPassword,
    };
    expect(input.displayName).toHaveLength(40);
    expect(setup.validatePasswordAccountInput(input)).toEqual(input);
    expect(publicUserDisplayNameSchema.parse(input.displayName)).toBe(
      input.displayName,
    );
    const overLimit = { ...input, displayName: character.repeat(21) };
    expect(
      publicUserDisplayNameSchema.safeParse(overLimit.displayName).success,
    ).toBe(false);
    const connect = vi.fn(async () => {
      throw new Error("UNEXPECTED_DATABASE_CONNECTION");
    });
    await expect(
      setup.provisionPasswordAccount({ connect }, overLimit),
    ).rejects.toThrow("OPERATOR_PASSWORD_SETUP_REFUSED");
    expect(connect).not.toHaveBeenCalled();
  },
);

it("protects operator inputs and refuses insecure Production configuration before connection", async () => {
  const { mkdtemp, writeFile, chmod, symlink, rm } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const setup = await import(
    new URL("../../../scripts/provision-password-account.mjs", import.meta.url)
      .href
  );
  const directory = await mkdtemp(join(tmpdir(), "operator-input-test-"));
  try {
    const file = join(directory, "input.json");
    const input = {
      requestId: randomUUID(),
      handle: "synthetic-user",
      displayName: "Synthetic",
      environment: "production",
      operatorLabel: "synthetic-operator",
      password: syntheticPassword,
    };
    await writeFile(file, JSON.stringify(input), { mode: 0o600 });
    expect(await setup.readPasswordAccountInput(file)).toEqual(input);
    await chmod(file, 0o640);
    await expect(setup.readPasswordAccountInput(file)).rejects.toThrow(
      "OPERATOR_PASSWORD_SETUP_REFUSED",
    );
    await chmod(file, 0o600);
    const link = join(directory, "link.json");
    await symlink(file, link);
    await expect(setup.readPasswordAccountInput(link)).rejects.toThrow(
      "OPERATOR_PASSWORD_SETUP_REFUSED",
    );
    await writeFile(file, " ".repeat(16385));
    await expect(setup.readPasswordAccountInput(file)).rejects.toThrow(
      "OPERATOR_PASSWORD_SETUP_REFUSED",
    );
    for (const suffix of [
      "",
      "?sslmode=disable",
      "?sslmode=require",
      "?sslmode=verify-full&sslmode=disable",
    ]) {
      await expect(
        setup.passwordAccountDatabaseConfiguration({
          NODE_ENV: "production",
          APP_PROVISION_DATABASE_URL: `postgres://operator@db.example.invalid/fixture${suffix}`,
        }),
      ).rejects.toThrow("OPERATOR_PASSWORD_SETUP_REFUSED");
    }
    expect(
      (
        await setup.passwordAccountDatabaseConfiguration({
          NODE_ENV: "production",
          APP_PROVISION_DATABASE_URL:
            "postgres://operator@db.example.invalid/fixture?sslmode=verify-full",
        })
      ).ssl,
    ).toEqual({ rejectUnauthorized: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
