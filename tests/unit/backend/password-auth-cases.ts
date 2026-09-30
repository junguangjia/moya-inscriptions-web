import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type {
  CommunityAuthPort,
  CommunityAuthService,
  AuthDeliveryPorts,
} from "@moya/api";

export interface PasswordHarness {
  service: CommunityAuthService;
  port: CommunityAuthPort;
  latestCode: () => string;
  advance: (ms: number) => void;
  suspend: (id: string) => Promise<void>;
  serviceForPort: (
    port: CommunityAuthPort,
    delivery?: AuthDeliveryPorts,
  ) => CommunityAuthService;
}
const requestKey = () => randomUUID();
const password = "SYNTHETIC_A1";
const replacement = "SyntheticB2雪";
const source = "synthetic-password-case";
const safe = (result: { ok: boolean; reason?: string; value?: unknown }) => {
  if (!result.ok) return { ok: false, reason: result.reason };
  const value = result.value as
    { reset?: boolean; profile?: { id: string } } | undefined;
  return {
    ok: true,
    ...(value?.reset === true
      ? { value: { reset: true } }
      : value?.profile
        ? { value: { profile: { id: value.profile.id } } }
        : {}),
  };
};
const begin = async (
  h: PasswordHarness,
  identifier: string,
  purpose: "register" | "password_reset",
) => {
  const sent = await h.service.sendChallenge({
    channel: "email",
    purpose,
    identifier,
    idempotencyKey: requestKey(),
    source,
  });
  if (!sent.ok || !sent.value.continuationToken)
    throw Error("Synthetic challenge rejected");
  const result = await h.service.verifyChallenge({
    challengeId: sent.value.challengeId,
    continuationToken: sent.value.continuationToken,
    code: h.latestCode(),
    idempotencyKey: requestKey(),
  });
  return result;
};
const registration = async (
  h: PasswordHarness,
  identifier: string,
  withPassword = true,
) => {
  const result = await begin(h, identifier, "register");
  if (!result.ok || result.value.outcome !== "registration_required")
    throw Error("Synthetic registration proof rejected");
  const body = {
    handoffToken: result.value.handoffToken,
    displayName: "Synthetic owner",
    studioName: "山🌿斋",
    agreement: true,
    idempotencyKey: requestKey(),
    source,
    ...(withPassword ? { password } : {}),
  };
  const registered = await h.service.confirmRegistration(body);
  if (!registered.ok) throw Error("Synthetic registration rejected");
  return { body, session: registered.value };
};
const login = (
  h: PasswordHarness,
  identifier: string,
  value = password,
  idempotencyKey = requestKey(),
) =>
  h.service.passwordLogin({
    channel: "email",
    identifier,
    password: value,
    idempotencyKey,
    source,
  });
const reset = async (h: PasswordHarness, identifier: string) => {
  const result = await begin(h, identifier, "password_reset");
  if (!result.ok || result.value.outcome !== "password_reset_required")
    throw Error("Synthetic reset proof rejected");
  return {
    handoffToken: result.value.handoffToken,
    password: replacement,
    idempotencyKey: requestKey(),
    source,
  };
};

type PasswordAttemptScope = "target" | "source" | "global";
/** Synthetic boundary counts avoid hundreds of actual password derivations. */
const passwordAttemptGate = (
  h: PasswordHarness,
  limitingScope: "source" | "global",
) => {
  const counts: Record<PasswordAttemptScope, number> = {
    target: 0,
    source: limitingScope === "source" ? 19 : 0,
    global: limitingScope === "global" ? 199 : 0,
  };
  const calls = {
    transactions: 0,
    identityReads: 0,
    credentialReads: 0,
    userLocks: 0,
    sessionWrites: 0,
    credentialWrites: 0,
    revocations: 0,
    reservations: 0,
  };
  const port: CommunityAuthPort = {
    transaction: (work) => {
      calls.transactions++;
      return h.port.transaction((tx) =>
        work({
          ...tx,
          sendCount: async (scope, key, since) => {
            if (scope === "target" || scope === "source" || scope === "global")
              return counts[scope];
            return tx.sendCount(scope, key, since);
          },
          addSend: async (scope, key, at) => {
            await tx.addSend(scope, key, at);
            if (
              scope === "target" ||
              scope === "source" ||
              scope === "global"
            ) {
              counts[scope]++;
              calls.reservations++;
            }
          },
          findIdentity: async (kind, digest) => {
            calls.identityReads++;
            return tx.findIdentity(kind, digest);
          },
          findPasswordCredential: async (id) => {
            calls.credentialReads++;
            return tx.findPasswordCredential(id);
          },
          lockUser: async (id) => {
            calls.userLocks++;
            return tx.lockUser(id);
          },
          insertSession: async (row) => {
            calls.sessionWrites++;
            return tx.insertSession(row);
          },
          savePasswordCredential: async (row, version) => {
            calls.credentialWrites++;
            return tx.savePasswordCredential(row, version);
          },
          revokeAllSessions: async (id, at) => {
            calls.revocations++;
            return tx.revokeAllSessions(id, at);
          },
        }),
      );
    },
  };
  return { service: h.serviceForPort(port), counts, calls };
};

/** Same business behavior is installed for memory and PostgreSQL App-role ports. */
export const passwordAuthCases = (make: () => PasswordHarness) => {
  it("rejects password login at the source limit before credential work or Session writes", async () => {
    const h = make(),
      email = `${requestKey()}@example.invalid`;
    await registration(h, email);
    const gate = passwordAttemptGate(h, "source"),
      limited = { ...h, service: gate.service };
    expect((await login(limited, email)).ok).toBe(true);
    expect(gate.counts).toEqual({ target: 1, source: 20, global: 1 });
    const before = { ...gate.calls };
    expect(safe(await login(limited, email))).toEqual({
      ok: false,
      reason: "AUTH_RATE_LIMITED",
    });
    expect(gate.calls).toEqual({
      ...before,
      transactions: before.transactions + 1,
    });
    expect(gate.counts).toEqual({ target: 1, source: 20, global: 1 });
  });
  it("rejects password login at the global limit before credential work or Session writes", async () => {
    const h = make(),
      email = `${requestKey()}@example.invalid`;
    await registration(h, email);
    const gate = passwordAttemptGate(h, "global"),
      limited = { ...h, service: gate.service };
    expect((await login(limited, email)).ok).toBe(true);
    expect(gate.counts).toEqual({ target: 1, source: 1, global: 200 });
    const before = { ...gate.calls };
    expect(safe(await login(limited, email))).toEqual({
      ok: false,
      reason: "AUTH_RATE_LIMITED",
    });
    expect(gate.calls).toEqual({
      ...before,
      transactions: before.transactions + 1,
    });
    expect(gate.counts).toEqual({ target: 1, source: 1, global: 200 });
  });
  it("reserves source and global attempts on exact registration receipt replays", async () => {
    const h = make(),
      email = `${requestKey()}@example.invalid`;
    const original = await registration(h, email);
    for (const scope of ["source", "global"] as const) {
      const gate = passwordAttemptGate(h, scope);
      expect(
        safe(await gate.service.confirmRegistration(original.body)),
      ).toMatchObject({ ok: true });
      expect(gate.counts).toEqual({
        target: 1,
        source: scope === "source" ? 20 : 1,
        global: scope === "global" ? 200 : 1,
      });
      const before = { ...gate.calls };
      expect(
        safe(await gate.service.confirmRegistration(original.body)),
      ).toEqual({ ok: false, reason: "AUTH_RATE_LIMITED" });
      // Proof/receipt lookup remains allowed; no final transaction may mint.
      expect(gate.calls).toEqual({
        ...before,
        transactions: before.transactions + 2,
        credentialReads: before.credentialReads + 1,
      });
      expect(gate.calls.reservations).toBe(3);
    }
  });
  it("reserves source and global attempts on exact reset receipt replays without further revocation", async () => {
    const h = make(),
      email = `${requestKey()}@example.invalid`;
    const original = await registration(h, email),
      command = await reset(h, email);
    expect(safe(await h.service.resetPassword(command))).toEqual({
      ok: true,
      value: { reset: true },
    });
    for (const scope of ["source", "global"] as const) {
      const gate = passwordAttemptGate(h, scope);
      expect(safe(await gate.service.resetPassword(command))).toEqual({
        ok: true,
        value: { reset: true },
      });
      expect(gate.counts).toEqual({
        target: 1,
        source: scope === "source" ? 20 : 1,
        global: scope === "global" ? 200 : 1,
      });
      expect(gate.calls.credentialWrites).toBe(0);
      expect(gate.calls.revocations).toBe(0);
      const before = { ...gate.calls };
      expect(safe(await gate.service.resetPassword(command))).toEqual({
        ok: false,
        reason: "AUTH_RATE_LIMITED",
      });
      expect(gate.calls).toEqual({
        ...before,
        transactions: before.transactions + 2,
        credentialReads: before.credentialReads + 1,
      });
      expect(gate.calls.reservations).toBe(3);
    }
    expect(
      (
        await h.port.transaction((tx) =>
          tx.findPasswordCredential(original.session.profile.id),
        )
      )?.version,
    ).toBe(2);
  });
  it("converges concurrent identical registration and reset commands without accepting changed payloads", async () => {
    const h = make(),
      email = `${requestKey()}@example.invalid`;
    const proof = await begin(h, email, "register");
    if (!proof.ok || proof.value.outcome !== "registration_required")
      throw Error("Synthetic proof rejected");
    const body = {
      handoffToken: proof.value.handoffToken,
      displayName: "Concurrent owner",
      studioName: "并发斋",
      password,
      agreement: true,
      idempotencyKey: requestKey(),
      source,
    };
    const [a, b] = await Promise.all([
      h.service.confirmRegistration(body),
      h.service.confirmRegistration(body),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok)
      throw Error("Synthetic concurrent registration rejected");
    expect(a.value.profile.id === b.value.profile.id).toBe(true);
    const command = await reset(h, email);
    const responses = await Promise.all([
      h.service.resetPassword(command),
      h.service.resetPassword(command),
    ]);
    expect(responses.every((result) => result.ok)).toBe(true);
    expect(
      (
        await h.port.transaction((tx) =>
          tx.findPasswordCredential(a.value.profile.id),
        )
      )?.version,
    ).toBe(2);
    expect(
      safe(
        await h.service.resetPassword({
          ...command,
          password: "SYNTHETIC_OTHER3",
        }),
      ),
    ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
  });
  it("never clears reset invalidation when an earlier email delivery accepts late", async () => {
    const h = make(),
      email = `${requestKey()}@example.invalid`;
    const original = await registration(h, email),
      command = await reset(h, email);
    let release!: () => void,
      started!: () => void,
      challengeId = "";
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    const capture: CommunityAuthPort = {
      transaction: (work) =>
        h.port.transaction((tx) =>
          work({
            ...tx,
            insertChallenge: async (row) => {
              challengeId = row.id;
              return tx.insertChallenge(row);
            },
          }),
        ),
    };
    const delayed = h.serviceForPort(capture, {
      sendEmail: async () => {
        started();
        await waiting;
        return { state: "accepted", correlation: "delayed-synthetic" };
      },
      sendPhone: async () => ({ state: "failed" }),
      checkPhone: async () => "fail",
    });
    const sending = delayed.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: email,
      idempotencyKey: requestKey(),
      source,
    });
    await reached;
    try {
      expect(safe(await h.service.resetPassword(command))).toMatchObject({
        ok: true,
      });
    } finally {
      release();
    }
    expect(safe(await sending)).toMatchObject({
      ok: false,
      reason: "AUTH_PROOF_REJECTED",
    });
    const row = await h.port.transaction((tx) => tx.findChallenge(challengeId));
    expect(row !== null && row.invalidatedAt !== null).toBe(true);
    expect((await h.service.readAccount(original.session.token)).ok).toBe(
      false,
    );
  });
  it("rejects suspended accounts generically after the same slow verification", async () => {
    const h = make(),
      email = `${requestKey()}@example.invalid`;
    const original = await registration(h, email);
    await h.suspend(original.session.profile.id);
    expect(safe(await login(h, email))).toMatchObject({
      ok: false,
      reason: "AUTH_INVALID_CREDENTIALS",
    });
  });
  it("rechecks the credential version when reset commits between slow verification and Session mint", async () => {
    const h = make(),
      email = `${requestKey()}@example.invalid`;
    await registration(h, email);
    const command = await reset(h, email);
    let calls = 0,
      release!: () => void,
      ready!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gated: CommunityAuthPort = {
      transaction: async (work) => {
        if (++calls === 2) {
          ready();
          await waiting;
        }
        return h.port.transaction(work);
      },
    };
    const signing = h.serviceForPort(gated).passwordLogin({
      channel: "email",
      identifier: email,
      password,
      idempotencyKey: requestKey(),
      source,
    });
    await reached;
    try {
      expect(safe(await h.service.resetPassword(command))).toMatchObject({
        ok: true,
      });
    } finally {
      release();
    }
    expect(safe(await signing)).toMatchObject({
      ok: false,
      reason: "AUTH_INVALID_CREDENTIALS",
    });
  });
  it("invalidates a still-unused anonymous sign-in challenge issued before registration", async () => {
    const h = make(),
      email = `${requestKey()}@example.invalid`;
    const sent = await h.service.sendChallenge({
      channel: "email",
      purpose: "sign_in",
      identifier: email,
      idempotencyKey: requestKey(),
      source,
    });
    if (!sent.ok || !sent.value.continuationToken)
      throw Error("Synthetic anonymous challenge rejected");
    const code = h.latestCode();
    await registration(h, email);
    const command = await reset(h, email);
    expect(safe(await h.service.resetPassword(command))).toMatchObject({
      ok: true,
    });
    expect(
      safe(
        await h.service.verifyChallenge({
          challengeId: sent.value.challengeId,
          continuationToken: sent.value.continuationToken,
          code,
          idempotencyKey: requestKey(),
        }),
      ),
    ).toMatchObject({ ok: false });
  });
  it("invalidates another already-issued reset proof and closes an earlier reset receipt", async () => {
    const h = make(),
      email = `${requestKey()}@example.invalid`;
    await registration(h, email);
    const first = await reset(h, email);
    h.advance(61_000);
    const second = await reset(h, email);
    expect(safe(await h.service.resetPassword(first))).toMatchObject({
      ok: true,
    });
    expect(safe(await h.service.resetPassword(second))).toMatchObject({
      ok: false,
      reason: "AUTH_PROOF_REJECTED",
    });
    h.advance(61_000);
    const newer = await reset(h, email);
    expect(
      safe(
        await h.service.resetPassword({ ...newer, password: "SYNTHETIC_C3" }),
      ),
    ).toMatchObject({ ok: true });
    expect(safe(await h.service.resetPassword(first))).toMatchObject({
      ok: false,
      reason: "AUTH_PROOF_REJECTED",
    });
  });
  it("registers a password and independent Unicode studio name without changing the nickname", async () => {
    const h = make(),
      email = `${requestKey()}@example.invalid`;
    const registered = await registration(h, email);
    const user = await h.port.transaction((tx) =>
      tx.findUser(registered.session.profile.id),
    );
    expect(user).toMatchObject({
      displayName: "Synthetic owner",
      studioName: "山🌿斋",
    });
    const signed = await login(h, email);
    expect(signed.ok && signed.value.profile.id).toBe(
      registered.session.profile.id,
    );
  });
  it("keeps missing accounts, OTP-only accounts and wrong passwords indistinguishable", async () => {
    const h = make(),
      email = `${requestKey()}@example.invalid`;
    await registration(h, email, false);
    for (const [target, input] of [
      [`${requestKey()}@example.invalid`, password],
      [email, password],
      [email, "SyntheticWrong3"],
    ]) {
      expect(safe(await login(h, target!, input!))).toMatchObject({
        ok: false,
        reason: "AUTH_INVALID_CREDENTIALS",
      });
    }
  });
  it("binds lost registration responses to nickname, studio and a slow-verified password", async () => {
    const h = make(),
      email = `${requestKey()}@example.invalid`;
    const original = await registration(h, email);
    expect(
      safe(
        await h.service.confirmRegistration({
          ...original.body,
          displayName: "Changed",
        }),
      ),
    ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    expect(
      safe(
        await h.service.confirmRegistration({
          ...original.body,
          studioName: "别斋",
        }),
      ),
    ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    expect(
      safe(
        await h.service.confirmRegistration({
          ...original.body,
          password: replacement,
        }),
      ),
    ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    expect(
      safe(await h.service.confirmRegistration(original.body)),
    ).toMatchObject({
      ok: true,
      value: { profile: { id: original.session.profile.id } },
    });
  });
  it("reset never signs in, revokes all Sessions and seals receipts while exact retries do no new work", async () => {
    const h = make(),
      email = `${requestKey()}@example.invalid`;
    const original = await registration(h, email),
      loginKey = requestKey();
    const signed = await login(h, email, password, loginKey);
    if (!signed.ok) throw Error("Synthetic login rejected");
    const command = await reset(h, email);
    expect(safe(await h.service.resetPassword(command))).toEqual({
      ok: true,
      value: { reset: true },
    });
    expect(
      safe(await h.service.readAccount(original.session.token)),
    ).toMatchObject({ ok: false, reason: "AUTH_UNAUTHENTICATED" });
    expect(safe(await h.service.readAccount(signed.value.token))).toMatchObject(
      { ok: false, reason: "AUTH_UNAUTHENTICATED" },
    );
    const fresh = await login(h, email, replacement);
    expect(fresh.ok).toBe(true);
    expect(safe(await h.service.resetPassword(command))).toEqual({
      ok: true,
      value: { reset: true },
    });
    if (fresh.ok)
      expect((await h.service.readAccount(fresh.value.token)).ok).toBe(true);
    expect(
      safe(await h.service.resetPassword({ ...command, password })),
    ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    h.advance(16 * 60 * 1000);
    expect(safe(await login(h, email, password, loginKey))).toMatchObject({
      ok: false,
      reason: "AUTH_INVALID_CREDENTIALS",
    });
    expect(
      safe(await h.service.confirmRegistration(original.body)),
    ).toMatchObject({ ok: false });
  });
  it("never converts an unknown-account reset proof into a registration or Session", async () => {
    const h = make();
    expect(
      safe(await begin(h, `${requestKey()}@example.invalid`, "password_reset")),
    ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    expect(await h.port.transaction((tx) => tx.countUsers())).toBe(0);
  });
  it("rejects register handoffs for reset and reset handoffs for registration", async () => {
    const h = make(),
      email = `${requestKey()}@example.invalid`;
    const original = await registration(h, email);
    expect(
      safe(
        await h.service.resetPassword({
          handoffToken: original.body.handoffToken,
          password: replacement,
          idempotencyKey: requestKey(),
        }),
      ),
    ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
    const command = await reset(h, email);
    expect(
      safe(
        await h.service.confirmRegistration({
          ...original.body,
          handoffToken: command.handoffToken,
          idempotencyKey: requestKey(),
        }),
      ),
    ).toMatchObject({ ok: false, reason: "AUTH_PROOF_REJECTED" });
  });
  it("reserves target attempts before password hashing", async () => {
    const h = make(),
      email = `${requestKey()}@example.invalid`;
    await registration(h, email);
    for (let i = 0; i < 7; i++)
      expect(safe(await login(h, email, "SyntheticWrong3"))).toMatchObject({
        ok: false,
        reason: "AUTH_INVALID_CREDENTIALS",
      });
    expect(safe(await login(h, email))).toMatchObject({
      ok: false,
      reason: "AUTH_RATE_LIMITED",
    });
    h.advance(16 * 60 * 1000);
    expect((await login(h, email)).ok).toBe(true);
  });
};

export {
  registration as registerPasswordCase,
  reset as preparePasswordResetCase,
};
