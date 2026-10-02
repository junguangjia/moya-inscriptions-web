import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CommunityAuthService,
  createProductionAuthService,
  hashSessionToken,
} from "@moya/api";
import type { AuthDeliveryPorts, CommunityAuthPort } from "@moya/api";

const agreement = {
  version: "synthetic-receipt-v1",
  title: "Synthetic",
  body: "Fixture only.",
};
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const harness = (
  environment: "development" | "production",
  createPort: () => CommunityAuthPort,
) => {
  const memory = createPort();
  let code = "",
    checks = 0,
    sequence = 0;
  let beforeTransaction: ((sequence: number) => Promise<void>) | undefined;
  let phoneCheck: (() => Promise<void>) | undefined;
  const locks: string[] = [];
  const port: CommunityAuthPort = {
    transaction: async (work) => {
      await beforeTransaction?.(++sequence);
      return memory.transaction((tx) =>
        work(
          new Proxy(tx, {
            get(target, property, receiver) {
              const value = Reflect.get(target, property, receiver);
              if (
                typeof property === "string" &&
                ["lockUser", "lockSession", "lockReceipt"].includes(property)
              )
                return (...args: unknown[]) => {
                  locks.push(property);
                  return value.apply(target, args);
                };
              return value;
            },
          }),
        ),
      );
    },
  };
  const keys = {
    version: 1,
    lookupKey: randomBytes(32),
    encryptionKey: randomBytes(32),
    otpKey: randomBytes(32),
  };
  const delivery: AuthDeliveryPorts = {
    sendEmail: async (input) => {
      code = input.code;
      return { state: "accepted", correlation: "synthetic" };
    },
    sendPhone: async (input) => {
      if (input.code !== null) code = input.code;
      return { state: "accepted", correlation: "synthetic" };
    },
    checkPhone: async () => {
      checks++;
      await phoneCheck?.();
      return "pass";
    },
  };
  const service =
    environment === "production"
      ? createProductionAuthService(
          port,
          { keys, phoneEnabled: true },
          delivery,
          agreement,
        )
      : new CommunityAuthService(port, {
          environment,
          profile: "full-local",
          keys,
          emailMode: "local_capture",
          phoneMode: "simulated",
          delivery,
        });
  const register = async (name: string) => {
    const sent = await service.sendChallenge({
      channel: "email",
      purpose: "register",
      identifier: `${name}@example.invalid`,
      idempotencyKey: randomUUID(),
      source: name,
    });
    if (!sent.ok || !sent.value.continuationToken)
      throw Error("Synthetic registration send refused");
    const verified = await service.verifyChallenge({
      challengeId: sent.value.challengeId,
      continuationToken: sent.value.continuationToken,
      code,
      idempotencyKey: randomUUID(),
    });
    if (!verified.ok || verified.value.outcome !== "registration_required")
      throw Error("Synthetic registration proof refused");
    const result = await service.confirmRegistration({
      handoffToken: verified.value.handoffToken,
      displayName: "合成回执",
      agreement: true,
      agreementVersion: agreement.version,
      idempotencyKey: randomUUID(),
    });
    if (!result.ok) throw Error("Synthetic registration refused");
    return result.value;
  };
  const reauthenticate = async (sessionToken: string) => {
    const reauth = await service.sendChallenge({
      channel: "email",
      purpose: "reauthenticate",
      sessionToken,
      idempotencyKey: randomUUID(),
      source: "reauth",
    });
    if (!reauth.ok || !reauth.value.continuationToken)
      throw Error("Synthetic reauth send refused");
    const proof = await service.verifyChallenge({
      challengeId: reauth.value.challengeId,
      continuationToken: reauth.value.continuationToken,
      code,
      idempotencyKey: randomUUID(),
    });
    if (!proof.ok || proof.value.outcome !== "reauthenticated")
      throw Error("Synthetic reauth refused");
    return proof.value.reauthToken;
  };
  const factor = async () => {
    const user = await register("receipt-owner");
    const reauthToken = await reauthenticate(user.token);
    const sent = await service.sendChallenge({
      channel: "phone",
      purpose: "link",
      identifier: "+8613800138011",
      reauthToken,
      sessionToken: user.token,
      idempotencyKey: randomUUID(),
      source: "link",
    });
    if (!sent.ok || !sent.value.continuationToken)
      throw Error("Synthetic factor send refused");
    return {
      user,
      input: {
        challengeId: sent.value.challengeId,
        continuationToken: sent.value.continuationToken,
        code: environment === "production" ? "123456" : code,
        reauthToken,
        sessionToken: user.token,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      },
    };
  };
  return {
    service,
    memory,
    register,
    factor,
    reauthenticate,
    locks,
    checks: () => checks,
    gateFinal: () => {
      const entered = deferred(),
        proceed = deferred();
      sequence = 0;
      beforeTransaction = async (index) => {
        if (index === 2) {
          entered.release();
          await proceed.promise;
        }
      };
      return { entered: entered.promise, release: proceed.release };
    },
    gatePhone: (hook: () => Promise<void>) => {
      phoneCheck = hook;
    },
  };
};

export const authFactorReceiptCases = (createPort: () => CommunityAuthPort) => {
  for (const environment of ["development", "production"] as const)
    describe(`${environment} completed factor receipt recovery`, () => {
      it("recovers the lost response with the original cookie and then retries the rotated cookie without another factor write/check", async () => {
        const h = harness(environment, createPort),
          { user, input } = await h.factor();
        const first = await h.service.completeFactor(input);
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expect((await h.service.readAccount(user.token)).ok).toBe(false);
        const recovered = await h.service.completeFactor(input);
        expect(recovered.ok).toBe(true);
        if (!recovered.ok) return;
        expect(recovered.value.session.profile.id === user.profile.id).toBe(
          true,
        );
        const retried = await h.service.completeFactor({
          ...input,
          sessionToken: recovered.value.session.token,
        });
        expect(retried.ok).toBe(true);
        if (!retried.ok) return;
        expect(
          (await h.service.readAccount(retried.value.session.token)).ok,
        ).toBe(true);
        expect(
          (await h.service.readAccount(recovered.value.session.token)).ok,
        ).toBe(false);
        const identities = await h.memory.transaction((tx) =>
          tx.listIdentities(user.profile.id),
        );
        expect(
          identities
            .filter((row) => row.kind === "phone")
            .map((row) => row.version),
        ).toEqual([1]);
        expect(h.checks()).toBe(environment === "production" ? 1 : 0);
      });
      it("recovers an intermediate cookie superseded by another exact concurrent retry", async () => {
        const h = harness(environment, createPort),
          { input } = await h.factor();
        const first = await h.service.completeFactor(input);
        const second = await h.service.completeFactor(input);
        const third = await h.service.completeFactor(input);
        if (!first.ok || !second.ok || !third.ok)
          throw Error("Synthetic recovery refused");
        const retry = await h.service.completeFactor({
          ...input,
          sessionToken: second.value.session.token,
        });
        expect(retry.ok).toBe(true);
        if (retry.ok)
          expect(
            (await h.service.readAccount(retry.value.session.token)).ok,
          ).toBe(true);
      });
      it("refuses a foreign Session and changed proof payload without consuming the completed owner's recovery", async () => {
        const h = harness(environment, createPort),
          { input } = await h.factor();
        const first = await h.service.completeFactor(input);
        if (!first.ok) throw Error("Synthetic completion refused");
        const foreign = await h.register("receipt-foreign");
        for (const change of [
          { sessionToken: foreign.token },
          { code: "not-the-completed-code" },
          { reauthToken: "synthetic-unrelated-proof" },
          { expectedVersion: 1 },
          { idempotencyKey: randomUUID() },
        ])
          expect(
            (await h.service.completeFactor({ ...input, ...change })).ok,
          ).toBe(false);
        expect((await h.service.completeFactor(input)).ok).toBe(true);
        expect((await h.service.readAccount(foreign.token)).ok).toBe(true);
        expect(h.checks()).toBe(environment === "production" ? 1 : 0);
      });
      it("serializes identical concurrent completions and retains one factor and one live receipt Session", async () => {
        const h = harness(environment, createPort),
          { user, input } = await h.factor();
        if (environment === "production") {
          let checks = 0;
          const both = deferred();
          h.gatePhone(async () => {
            if (++checks === 2) both.release();
            await both.promise;
          });
        }
        const results = await Promise.all([
          h.service.completeFactor(input),
          h.service.completeFactor(input),
        ]);
        expect(results.map((result) => result.ok)).toEqual([true, true]);
        const live = await Promise.all(
          results.map(
            async (result) =>
              result.ok &&
              (await h.service.readAccount(result.value.session.token)).ok,
          ),
        );
        expect(live.filter(Boolean)).toHaveLength(1);
        const identities = await h.memory.transaction((tx) =>
          tx.listIdentities(user.profile.id),
        );
        expect(
          identities
            .filter((row) => row.kind === "phone")
            .map((row) => row.version),
        ).toEqual([1]);
      });
      for (const cookie of [
        "original",
        "issued",
        "recovered",
        "intermediate",
      ] as const)
        it(`logout of the ${cookie} cookie seals the same completed recovery lineage`, async () => {
          const h = harness(environment, createPort),
            { input } = await h.factor();
          const first = await h.service.completeFactor(input);
          if (!first.ok) throw Error("Synthetic completion refused");
          const second = await h.service.completeFactor(input);
          if (!second.ok) throw Error("Synthetic recovery refused");
          let latest = second.value.session.token;
          if (cookie === "intermediate") {
            const third = await h.service.completeFactor(input);
            if (!third.ok) throw Error("Synthetic third recovery refused");
            latest = third.value.session.token;
          }
          const selected =
            cookie === "original"
              ? input.sessionToken
              : cookie === "issued"
                ? first.value.session.token
                : second.value.session.token;
          expect((await h.service.signOut(selected)).ok).toBe(true);
          expect((await h.service.completeFactor(input)).ok).toBe(false);
          expect(
            (
              await h.service.completeFactor({
                ...input,
                sessionToken: second.value.session.token,
              })
            ).ok,
          ).toBe(false);
          expect((await h.service.readAccount(latest)).ok).toBe(false);
        });
      for (const cookie of ["original", "issued"] as const)
        it(`refuses recovery if ${cookie} logout wins between receipt preflight and the final transaction`, async () => {
          const h = harness(environment, createPort),
            { input } = await h.factor();
          const first = await h.service.completeFactor(input);
          if (!first.ok) throw Error("Synthetic completion refused");
          const gate = h.gateFinal();
          const recovery = h.service.completeFactor(input);
          await gate.entered;
          expect(
            (
              await h.service.signOut(
                cookie === "original"
                  ? input.sessionToken
                  : first.value.session.token,
              )
            ).ok,
          ).toBe(true);
          gate.release();
          expect((await recovery).ok).toBe(false);
          expect(
            (await h.service.readAccount(first.value.session.token)).ok,
          ).toBe(false);
        });
      it("serializes actual concurrent logout and recovery without leaving a live recovered Session", async () => {
        const h = harness(environment, createPort),
          { input } = await h.factor();
        const first = await h.service.completeFactor(input);
        if (!first.ok) throw Error("Synthetic completion refused");
        const second = await h.service.completeFactor(input);
        if (!second.ok) throw Error("Synthetic recovery refused");
        const [recovered, logout] = await Promise.all([
          h.service.completeFactor(input),
          h.service.signOut(second.value.session.token),
        ]);
        expect(logout.ok).toBe(true);
        if (recovered.ok)
          expect(
            (await h.service.readAccount(recovered.value.session.token)).ok,
          ).toBe(false);
        expect((await h.service.completeFactor(input)).ok).toBe(false);
      });
      it("takes the User lock before unlink receipt Session locks and serializes replay with logout", async () => {
        const h = harness(environment, createPort),
          { input } = await h.factor();
        const linked = await h.service.completeFactor(input);
        if (!linked.ok) throw Error("Synthetic link refused");
        const unlinkInput = {
          channel: "phone" as const,
          reauthToken: await h.reauthenticate(linked.value.session.token),
          expectedVersion: 1,
          idempotencyKey: randomUUID(),
          sessionToken: linked.value.session.token,
        };
        const unlinked = await h.service.unlinkFactor(unlinkInput);
        if (!unlinked.ok) throw Error("Synthetic unlink refused");
        h.locks.length = 0;
        const replay = await h.service.unlinkFactor({
          ...unlinkInput,
          sessionToken: unlinked.value.session.token,
        });
        expect(replay.ok).toBe(true);
        expect(h.locks[0]).toBe("lockUser");
        expect(h.locks.indexOf("lockSession")).toBeGreaterThan(0);
        expect(h.locks.indexOf("lockReceipt")).toBeGreaterThan(0);
        if (!replay.ok) return;
        const [concurrent, logout] = await Promise.all([
          h.service.unlinkFactor({
            ...unlinkInput,
            sessionToken: replay.value.session.token,
          }),
          h.service.signOut(unlinked.value.session.token),
        ]);
        expect(logout.ok).toBe(true);
        if (concurrent.ok)
          expect(
            (await h.service.readAccount(concurrent.value.session.token)).ok,
          ).toBe(false);
        expect(
          (await h.service.readAccount(replay.value.session.token)).ok,
        ).toBe(false);
      });
      it("indexes the completed factor receipt from its original Session for logout", async () => {
        const h = harness(environment, createPort),
          { user, input } = await h.factor();
        const first = await h.service.completeFactor(input);
        if (!first.ok) throw Error("Synthetic completion refused");
        const receipts = await h.memory.transaction(async (tx) => {
          const session = await tx.findSession(
            await hashSessionToken(input.sessionToken),
          );
          return session === null ? [] : tx.lockReceiptsForSession(session.id);
        });
        expect(
          receipts.some(
            (receipt) =>
              receipt.purpose === `factor_change:${input.challengeId}` &&
              receipt.userId === user.profile.id,
          ),
        ).toBe(true);
      });
    });
};
