import type {
  AuthRegistrationAgreement,
  AuthAccountSecurity,
  AuthCapabilities,
  AuthChallengeAccepted,
  AuthFactor,
  PublicUserId,
  PublicUserProfile,
} from "@moya/contracts";

import { normalizeStudioNameInput } from "../../domain/auth-profile-policy.js";
import {
  hashPassword,
  verifyPassword,
  validPassword,
  PasswordHashBusyError,
} from "./password-crypto.js";

import { mapPublicUserProfile } from "../mappers/community-public-contract-mapper.js";
import {
  defaultRandomBytes,
  generateOpaqueId,
  generateSessionToken,
  hashSessionToken,
} from "../session-token.js";
import type {
  AuthChannelName,
  AuthEnvironmentName,
  AuthPurposeName,
  AuthUnitOfWork,
  CommunityAuthPort,
  StoredChallenge,
  StoredHandoff,
  StoredIdentity,
  StoredReceipt,
  StoredUser,
  StoredPasswordCredential,
  StoredPasswordResetReceipt,
  VerificationMode,
} from "./auth-port.js";
import {
  assertAuthKeys,
  decryptContact,
  encryptContact,
  generateEmailOtp,
  keyedHash,
  lookupDigest,
  maskEmail,
  maskPhone,
  normalizeEmail,
  normalizePhone,
  otpVerifier,
  verifierMatches,
} from "./contact-crypto.js";
import type { AuthKeys } from "./contact-crypto.js";
import type { DeliveryOutcome } from "./delivery.js";
import type { RandomBytes } from "../session-token.js";

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const TARGET_SENDS = 8;
const SOURCE_SENDS = 20;
const GLOBAL_SENDS = 200;
const HANDOFF_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HANDLE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export const authReasons = [
  "AUTH_CHANNEL_UNAVAILABLE",
  "AUTH_INVALID_IDENTIFIER",
  "AUTH_INVALID_DISPLAY_NAME",
  "AUTH_INVALID_STUDIO_NAME",
  "AUTH_INVALID_PASSWORD",
  "AUTH_INVALID_CREDENTIALS",
  "AUTH_AGREEMENT_REQUIRED",
  "AUTH_RATE_LIMITED",
  "AUTH_CODE_EXHAUSTED",
  "AUTH_CODE_INVALID",
  "AUTH_CODE_EXPIRED",
  "AUTH_CODE_SUPERSEDED",
  "AUTH_PROOF_REJECTED",
  "AUTH_IDENTIFIER_CONFLICT",
  "AUTH_LAST_FACTOR",
  "AUTH_STALE_VERSION",
  "AUTH_ACCOUNT_SUSPENDED",
  "AUTH_UNAUTHENTICATED",
  "AUTH_DELIVERY_FAILED",
  "AUTH_DELIVERY_UNKNOWN",
  "AUTH_PROVENANCE_REJECTED",
  "AUTH_NOT_CONFIGURED",
] as const;

export type AuthReason = (typeof authReasons)[number];
export type AuthResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: AuthReason };

export interface AuthSessionGrant {
  readonly token: string;
  readonly expiresAt: string;
  readonly profile: PublicUserProfile;
}

export type AuthVerifyValue =
  | { readonly outcome: "signed_in"; readonly session: AuthSessionGrant }
  | {
      readonly outcome: "registration_required" | "password_reset_required";
      readonly handoffToken: string;
      readonly maskedTarget: string;
      readonly channel: AuthChannelName;
    }
  | {
      readonly outcome: "already_registered";
      readonly channel: AuthChannelName;
    }
  | { readonly outcome: "reauthenticated"; readonly reauthToken: string };

export interface AuthDeliveryPorts {
  sendEmail(input: {
    readonly to: string;
    readonly code: string;
    readonly minutes: number;
  }): Promise<DeliveryOutcome>;
  sendPhone(input: {
    readonly e164: string;
    readonly code: string | null;
    readonly outId: string;
    readonly minutes: number;
  }): Promise<DeliveryOutcome>;
  checkPhone(input: {
    readonly e164: string;
    readonly code: string;
    readonly outId: string;
  }): Promise<"pass" | "fail" | "malformed" | "unknown">;
}

export interface CommunityAuthServiceOptions {
  readonly environment: AuthEnvironmentName;
  readonly profile: "full-local" | "email-first" | "password-only";
  readonly keys: AuthKeys;
  readonly emailMode: VerificationMode | "disabled";
  readonly phoneMode: VerificationMode | "disabled";
  readonly delivery: AuthDeliveryPorts;
  readonly clock?: () => Date;
  readonly randomBytes?: RandomBytes;
  readonly sessionTtlMs?: number;
  readonly registrationAgreement?: AuthRegistrationAgreement | null;
}

interface Target {
  readonly digest: string;
  readonly destination: string;
  readonly masked: string;
  readonly ciphertext: string;
  readonly userId: string | null;
  readonly sessionHash: string | null;
  readonly expectedVersion: number | null;
  readonly reauthHash: string | null;
  readonly identityId?: string | null;
  readonly credentialVersion?: number | null;
}

interface Minted extends AuthSessionGrant {
  readonly sessionId: string;
  readonly tokenHash: string;
}

type Reservation =
  | { readonly kind: "replay"; readonly accepted: AuthChallengeAccepted }
  | {
      readonly kind: "send";
      readonly challenge: StoredChallenge;
      readonly continuationToken: string;
      readonly destination: string;
      readonly code: string | null;
    };

class PasswordReceiptRace extends Error {}

class AuthRollback extends Error {
  constructor(readonly result: AuthResult<unknown>) {
    super("auth rollback");
  }
}

const fail = <T>(reason: AuthReason): AuthResult<T> => ({
  ok: false,
  reason,
});

/** Check-constraint backstop when an attempt counter would pass five. */
const attemptsBound = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  if ("kind" in error && error.kind === "attempts") return true;
  const code = "code" in error ? String(error.code) : "";
  const constraint = "constraint" in error ? String(error.constraint) : "";
  const message = "message" in error ? String(error.message) : "";
  return (
    code === "23514" &&
    (constraint === "auth_challenges_attempts_bounded" ||
      message.includes("auth_challenges_attempts_bounded"))
  );
};

/**
 * Email-first registration, sign-in and factor binding on the existing
 * public-user and session tables. Session tokens are minted only after a
 * purpose-bound proof and are never stored in receipts.
 */
export class CommunityAuthService {
  private readonly clock: () => Date;
  private readonly randomBytes: RandomBytes;
  private readonly sessionTtlMs: number;
  private readonly registrationAgreement: AuthRegistrationAgreement | null;

  constructor(
    private readonly port: CommunityAuthPort,
    private readonly options: CommunityAuthServiceOptions,
  ) {
    assertAuthKeys(options.keys);
    if (
      options.environment === "production" &&
      (options.profile === "full-local" ||
        (options.profile === "password-only"
          ? options.emailMode !== "disabled" || options.phoneMode !== "disabled"
          : options.emailMode !== "provider" ||
            (options.phoneMode !== "provider" &&
              options.phoneMode !== "disabled")))
    )
      throw new Error("Production authentication requires real provider modes");
    this.registrationAgreement =
      options.registrationAgreement == null
        ? null
        : Object.freeze({ ...options.registrationAgreement });
    this.clock = options.clock ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  capabilities(): AuthCapabilities {
    const phone = this.channelAvailable("phone");
    const email = this.channelAvailable("email");
    return {
      profile: this.options.profile,
      email: {
        available: email,
        reason: email ? null : "Email verification is unavailable.",
      },
      password: {
        available: true,
        identifiers:
          this.options.profile === "password-only"
            ? ["handle"]
            : phone
              ? ["email", "phone"]
              : ["email"],
        reason: null,
      },
      phone: phone
        ? { available: true, reason: null }
        : {
            available: false,
            reason: "Phone sign-in is turned off in this acceptance profile.",
          },
      developmentOnly: this.options.environment === "development",
      ...(this.options.environment === "production"
        ? {
            registration: !this.registrationAvailable()
              ? {
                  available: false,
                  agreement: null,
                  reason: "Registration agreement is not configured.",
                }
              : {
                  available: true,
                  agreement: { ...this.registrationAgreement! },
                  reason: null,
                },
          }
        : {}),
    };
  }

  async sendChallenge(input: {
    readonly channel: AuthChannelName;
    readonly purpose: AuthPurposeName;
    readonly identifier?: string | undefined;
    readonly idempotencyKey: string;
    readonly source: string;
    readonly sessionToken?: string | undefined;
    readonly reauthToken?: string | undefined;
  }): Promise<AuthResult<AuthChallengeAccepted>> {
    if (this.options.profile === "password-only")
      return fail("AUTH_CHANNEL_UNAVAILABLE");
    if (input.purpose === "register" && !this.registrationAvailable())
      return fail("AUTH_NOT_CONFIGURED");
    if (!this.channelAvailable(input.channel))
      return fail("AUTH_CHANNEL_UNAVAILABLE");
    const at = this.clock();
    const session = await this.optionalSession(input.sessionToken, at);
    if (!session.ok) return session;
    const target = await this.resolveTarget(input, session.value, at);
    if (!target.ok) return target;
    const reserved = await this.transactional<Reservation>((tx) =>
      this.reserve(tx, input, target.value, at),
    );
    if (!reserved.ok) return reserved;
    if (reserved.value.kind === "replay")
      return { ok: true, value: reserved.value.accepted };
    const delivery = await this.deliver(reserved.value);
    const marked = await this.transactional<"accepted" | "failed" | "unknown">(
      async (tx) => {
        const current = await tx.findChallenge(
          reserved.value.kind === "send" ? reserved.value.challenge.id : "",
        );
        if (current === null || reserved.value.kind !== "send")
          return fail("AUTH_PROOF_REJECTED");
        if (
          current.invalidatedAt !== null ||
          current.supersededAt !== null ||
          current.completedAt !== null
        )
          return fail("AUTH_PROOF_REJECTED");
        await tx.saveChallenge({
          ...current,
          deliveryState:
            delivery.state === "accepted" ? "accepted" : delivery.state,
          providerCorrelation:
            delivery.state === "accepted"
              ? delivery.correlation
              : current.providerCorrelation,
          invalidatedAt:
            delivery.state === "accepted" ? null : current.createdAt,
          resendAvailableAt:
            delivery.state === "accepted"
              ? current.resendAvailableAt
              : current.createdAt,
        });
        return { ok: true, value: delivery.state };
      },
    );
    if (!marked.ok) return marked;
    if (marked.value !== "accepted")
      return fail(
        marked.value === "unknown"
          ? "AUTH_DELIVERY_UNKNOWN"
          : "AUTH_DELIVERY_FAILED",
      );
    return {
      ok: true,
      value: {
        challengeId: reserved.value.challenge.id,
        resendAvailableAt: reserved.value.challenge.resendAvailableAt,
        maskedTarget: target.value.masked,
        continuationToken: reserved.value.continuationToken,
      },
    };
  }

  async verifyChallenge(input: {
    readonly challengeId: string;
    readonly code: string;
    readonly continuationToken: string;
    readonly idempotencyKey: string;
  }): Promise<AuthResult<AuthVerifyValue>> {
    if (this.options.profile === "password-only")
      return fail("AUTH_CHANNEL_UNAVAILABLE");
    const at = this.clock();
    const continuationHash = await hashSessionToken(input.continuationToken);
    const loaded = await this.transactional<{
      challenge: StoredChallenge;
      checkProvider: boolean;
    }>(async (tx) => {
      const challenge = await tx.findChallenge(input.challengeId);
      if (challenge === null || challenge.continuationHash !== continuationHash)
        return fail("AUTH_PROOF_REJECTED");
      let checkProvider = challenge.strategy === "provider_generated";
      if (checkProvider) {
        if (!this.challengeModeOk(challenge))
          return fail("AUTH_PROVENANCE_REJECTED");
        if (challenge.invalidatedAt !== null || challenge.supersededAt !== null)
          return this.staleChallenge(challenge, at);
        const receipt = await tx.findReceipt(
          await this.receiptKey(
            input.idempotencyKey,
            challenge.targetDigest,
            challenge.purpose,
          ),
        );
        // Receipt replay is authorized by the final locked transaction. It never
        // spends another provider verification attempt, even after OTP expiry.
        if (receipt !== null && challenge.purpose === "sign_in")
          checkProvider = false;
        else {
          const ready = await this.providerChallengeReady(tx, challenge, at);
          if (!ready.ok) return ready;
          if (challenge.purpose === "link" || challenge.purpose === "replace")
            return fail("AUTH_PROOF_REJECTED");
          const identity = await tx.findIdentity(
            challenge.channel,
            challenge.targetDigest,
          );
          if (
            (challenge.purpose === "register" ||
              (challenge.purpose === "sign_in" && identity === null)) &&
            !this.registrationAvailable()
          )
            return fail("AUTH_NOT_CONFIGURED");
          if (identity !== null && challenge.purpose !== "register") {
            if (!this.provenanceOk(identity))
              return fail("AUTH_PROVENANCE_REJECTED");
            const user = await tx.findUser(identity.userId);
            if (user === null || user.status !== "active")
              return fail("AUTH_ACCOUNT_SUSPENDED");
          }
          if (challenge.purpose === "reauthenticate") {
            const user =
              challenge.sessionHash === null
                ? null
                : await tx.findSessionUser(
                    challenge.sessionHash,
                    at.toISOString(),
                    this.requiredSessionEnvironment(),
                  );
            if (user === null || user.id !== challenge.userId)
              return fail("AUTH_UNAUTHENTICATED");
            if (user.status !== "active") return fail("AUTH_ACCOUNT_SUSPENDED");
          }
        }
      }
      return { ok: true, value: { challenge, checkProvider } };
    });
    if (!loaded.ok) return loaded;
    let providerPassed = false;
    if (loaded.value.checkProvider) {
      const plain = await decryptContact(
        this.options.keys,
        loaded.value.challenge.channel,
        loaded.value.challenge.ciphertext,
      );
      if (plain === null) return fail("AUTH_PROOF_REJECTED");
      const checked = await this.options.delivery.checkPhone({
        e164: plain,
        code: input.code,
        outId: loaded.value.challenge.id,
      });
      if (checked === "unknown") return fail("AUTH_DELIVERY_UNKNOWN");
      if (checked === "malformed") return fail("AUTH_DELIVERY_FAILED");
      providerPassed = checked === "pass";
    }
    return this.transactional<AuthVerifyValue>((tx) =>
      this.finishVerify(
        tx,
        input,
        continuationHash,
        providerPassed,
        this.clock(),
      ),
    );
  }

  async confirmRegistration(input: {
    readonly handoffToken: string;
    readonly displayName: string;
    readonly agreement: boolean;
    readonly agreementVersion?: string | undefined;
    readonly idempotencyKey: string;
    readonly password?: string | undefined;
    readonly studioName?: string | undefined;
    readonly studioNameSuffix?: string | undefined;
    readonly source?: string;
  }): Promise<AuthResult<AuthSessionGrant>> {
    if (
      !this.registrationAvailable() ||
      (this.options.environment === "production" &&
        input.agreementVersion !== this.registrationAgreement?.version)
    )
      return fail("AUTH_NOT_CONFIGURED");
    if (input.agreement !== true) return fail("AUTH_AGREEMENT_REQUIRED");
    const displayName = input.displayName.trim();
    if (
      displayName !== input.displayName ||
      displayName.length < 1 ||
      displayName.length > 40 ||
      displayName.includes("\u0000") ||
      /[\uD800-\uDFFF]/u.test(displayName)
    )
      return fail("AUTH_INVALID_DISPLAY_NAME");
    const studio = normalizeStudioNameInput(
      input.studioName,
      input.studioNameSuffix,
    );
    if (studio === null) return fail("AUTH_INVALID_STUDIO_NAME");
    if (input.password !== undefined && !validPassword(input.password))
      return fail("AUTH_INVALID_PASSWORD");
    const at = this.clock(),
      tokenHash = await hashSessionToken(input.handoffToken);
    const preflight = await this.transactional<{
      handoff: StoredHandoff;
      receiptKey: string;
      receipt: StoredReceipt | null;
      credential: StoredPasswordCredential | null;
    }>(async (tx) => {
      const handoff = await tx.findHandoff(tokenHash);
      if (
        handoff === null ||
        handoff.purpose !== "register_confirm" ||
        !this.handoffModeOk(handoff)
      )
        return fail("AUTH_PROOF_REJECTED");
      const receiptKey = await this.receiptKey(
        input.idempotencyKey,
        handoff.targetDigest,
        "register",
      );
      const receipt = await tx.findReceipt(receiptKey);
      if (
        receipt?.closedAt != null ||
        (receipt === null &&
          (handoff.consumedAt !== null ||
            new Date(handoff.expiresAt).getTime() <= at.getTime()))
      )
        return fail("AUTH_PROOF_REJECTED");
      const credential =
        receipt === null
          ? null
          : await tx.findPasswordCredential(receipt.userId);
      return {
        ok: true as const,
        value: { handoff, receiptKey, receipt, credential },
      };
    });
    if (!preflight.ok) return preflight;
    const prepared = preflight.value;
    if (input.password !== undefined) {
      const budget = await this.transactional((tx) =>
        this.reservePasswordAttempt(
          tx,
          prepared.handoff.targetDigest,
          input.source ?? "unknown",
          at,
        ),
      );
      if (!budget.ok) return budget;
    }
    let verifier: string | null = null;
    try {
      if (prepared.receipt !== null) {
        if (
          input.password === undefined
            ? prepared.credential !== null
            : prepared.credential === null ||
              !(await verifyPassword(
                input.password,
                prepared.credential.verifier,
              ))
        )
          return fail("AUTH_PROOF_REJECTED");
        verifier = prepared.credential?.verifier ?? null;
      } else if (input.password !== undefined)
        verifier = await hashPassword(input.password);
    } catch (error) {
      if (error instanceof PasswordHashBusyError)
        return fail("AUTH_RATE_LIMITED");
      throw error;
    }
    const payloadHash = await this.registrationPayload(
      displayName,
      studio.studioName,
      studio.studioNameSuffix,
      verifier,
    );
    return this.convergeReceiptRace(
      () => this.confirmRegistration(input),
      () =>
        this.transactional<AuthSessionGrant>(async (tx) => {
          const handoff = await tx.findHandoff(tokenHash);
          if (
            handoff === null ||
            handoff.purpose !== "register_confirm" ||
            !this.handoffModeOk(handoff)
          )
            return fail("AUTH_PROOF_REJECTED");
          if (new Date(handoff.expiresAt).getTime() <= at.getTime())
            return fail("AUTH_CODE_EXPIRED");
          await tx.lockDigest(handoff.targetDigest);
          const receipt = await tx.findReceipt(prepared.receiptKey);
          if (receipt !== null) {
            const user = await tx.lockUser(receipt.userId);
            if (user === null || user.status !== "active")
              return fail("AUTH_ACCOUNT_SUSPENDED");
            const credential = await tx.findPasswordCredential(user.id);
            if (prepared.receipt === null) throw new PasswordReceiptRace();
            if (
              (credential?.version ?? null) !==
              (prepared.credential?.version ?? null)
            )
              return fail("AUTH_PROOF_REJECTED");
            if (receipt.payloadHash == null) {
              if (this.options.environment === "production")
                return fail("AUTH_PROOF_REJECTED");
              // Legacy receipts may replay only their original OTP-only public fields.
              if (
                input.password !== undefined ||
                studio.studioName !== (user.studioName ?? "") ||
                studio.studioNameSuffix !== (user.studioNameSuffix ?? "") ||
                displayName !== user.displayName
              )
                return fail("AUTH_PROOF_REJECTED");
            } else if (
              receipt.payloadHash !== payloadHash ||
              (receipt.credentialVersion ?? null) !==
                (credential?.version ?? null)
            )
              return fail("AUTH_PROOF_REJECTED");
            return {
              ok: true,
              value: await this.reissue(tx, receipt, user, handoff.channel, at),
            };
          }
          if (handoff.consumedAt !== null) return fail("AUTH_PROOF_REJECTED");
          if (
            (await tx.findIdentity(handoff.channel, handoff.targetDigest)) !==
            null
          )
            throw new AuthRollback(fail("AUTH_IDENTIFIER_CONFLICT"));
          if ((await tx.consumeHandoff(handoff.id, at.toISOString())) !== "ok")
            return fail("AUTH_PROOF_REJECTED");
          const user = await this.insertNewUser(
            tx,
            displayName,
            studio.studioName,
            studio.studioNameSuffix,
          );
          if (
            (await tx.insertIdentity({
              id: generateOpaqueId("login", this.randomBytes),
              userId: user.id,
              kind: handoff.channel,
              lookupDigest: handoff.targetDigest,
              ciphertext: handoff.ciphertext,
              lookupKeyVersion: this.options.keys.version,
              verificationMode: handoff.providerMode,
              environment: handoff.environment,
              version: 1,
              verifiedAt: at.toISOString(),
            })) === "conflict"
          )
            throw new AuthRollback(fail("AUTH_IDENTIFIER_CONFLICT"));
          if (
            verifier !== null &&
            (await tx.savePasswordCredential(
              {
                userId: user.id,
                verifier,
                version: 1,
                updatedAt: at.toISOString(),
              },
              null,
            )) !== "ok"
          )
            throw new AuthRollback(fail("AUTH_PROOF_REJECTED"));
          const session = await this.mint(tx, user, handoff.channel, at);
          await tx.insertReceipt({
            keyHash: prepared.receiptKey,
            userId: user.id,
            sessionId: session.sessionId,
            sessionTokenHash: session.tokenHash,
            purpose: "register",
            originSessionId: session.sessionId,
            closedAt: null,
            payloadHash,
            credentialVersion: verifier === null ? null : 1,
          });
          await this.audit(tx, user.id, "register", at);
          return { ok: true, value: session };
        }),
    );
  }

  async passwordLogin(input: {
    readonly channel: AuthChannelName | "handle";
    readonly identifier: string;
    readonly password: string;
    readonly idempotencyKey: string;
    readonly source: string;
  }): Promise<AuthResult<AuthSessionGrant>> {
    const handleLogin = input.channel === "handle";
    if (
      this.options.profile === "password-only"
        ? !handleLogin
        : handleLogin ||
          !this.channelAvailable(input.channel as AuthChannelName)
    )
      return fail("AUTH_CHANNEL_UNAVAILABLE");
    const normalized = handleLogin
      ? /^[a-z][a-z0-9-]{2,31}$/u.test(input.identifier)
        ? { lookup: input.identifier }
        : null
      : this.normalize(input.channel as AuthChannelName, input.identifier);
    if (normalized === null) return fail("AUTH_INVALID_IDENTIFIER");
    const digest = handleLogin
      ? await keyedHash(
          this.options.keys.lookupKey,
          `password-handle\0${normalized.lookup}`,
        )
      : await lookupDigest(
          input.channel as AuthChannelName,
          normalized.lookup,
          this.options.keys,
        );
    const sessionMethod = handleLogin
      ? "password"
      : (input.channel as AuthChannelName);
    const at = this.clock();
    // Every attempt reserves all three scopes atomically before expensive work.
    const reserved = await this.transactional(async (tx) => {
      const budget = await this.reservePasswordAttempt(
        tx,
        digest,
        input.source,
        at,
      );
      if (!budget.ok) return budget;
      const identity = handleLogin
        ? null
        : await tx.findIdentity(input.channel as AuthChannelName, digest);
      const user = handleLogin
        ? await tx.findProvisionedPasswordUser(
            normalized.lookup,
            this.options.environment,
          )
        : identity === null
          ? null
          : await tx.findUser(identity.userId);
      const credential =
        user === null ? null : await tx.findPasswordCredential(user.id);
      return { ok: true as const, value: { identity, user, credential } };
    });
    if (!reserved.ok) return reserved;
    const { identity, user, credential } = reserved.value;
    let matched: boolean;
    try {
      matched = await verifyPassword(
        input.password,
        user?.status === "active" &&
          (handleLogin || (identity !== null && this.provenanceOk(identity)))
          ? (credential?.verifier ?? null)
          : null,
      );
    } catch (error) {
      if (error instanceof PasswordHashBusyError)
        return fail("AUTH_RATE_LIMITED");
      throw error;
    }
    if (
      !matched ||
      (!handleLogin && identity === null) ||
      user === null ||
      credential === null ||
      user.status !== "active" ||
      (!handleLogin && (identity === null || !this.provenanceOk(identity)))
    )
      return fail("AUTH_INVALID_CREDENTIALS");
    return this.transactional<AuthSessionGrant>(async (tx) => {
      const currentUser = await tx.lockUser(user.id);
      const currentIdentity = handleLogin
        ? null
        : await tx.findIdentity(input.channel as AuthChannelName, digest);
      const currentProvisioned = handleLogin
        ? await tx.findProvisionedPasswordUser(
            normalized.lookup,
            this.options.environment,
          )
        : null;
      const currentCredential = await tx.findPasswordCredential(user.id);
      if (
        currentUser?.status !== "active" ||
        (handleLogin
          ? currentProvisioned?.id !== user.id
          : identity === null ||
            currentIdentity === null ||
            currentIdentity.id !== identity.id ||
            currentIdentity.version !== identity.version ||
            currentIdentity.userId !== user.id ||
            !this.provenanceOk(currentIdentity)) ||
        currentCredential?.version !== credential.version ||
        currentCredential.verifier !== credential.verifier
      )
        return fail("AUTH_INVALID_CREDENTIALS");
      const receiptKey = await this.receiptKey(
        input.idempotencyKey,
        digest,
        "password_login",
      );
      // Bind the salted slow verifier, never a fast fingerprint of the password.
      const payloadHash = await keyedHash(
        this.options.keys.lookupKey,
        JSON.stringify([
          input.channel,
          digest,
          credential.verifier,
          credential.version,
        ]),
      );
      const receipt = await tx.findReceipt(receiptKey);
      if (receipt !== null) {
        if (
          receipt.userId !== user.id ||
          receipt.payloadHash !== payloadHash ||
          receipt.credentialVersion !== credential.version
        )
          return fail("AUTH_PROOF_REJECTED");
        return {
          ok: true,
          value: await this.reissue(
            tx,
            receipt,
            currentUser,
            sessionMethod,
            at,
          ),
        };
      }
      const session = await this.mint(tx, currentUser, sessionMethod, at);
      await tx.insertReceipt({
        keyHash: receiptKey,
        userId: user.id,
        sessionId: session.sessionId,
        sessionTokenHash: session.tokenHash,
        purpose: "password_login",
        originSessionId: session.sessionId,
        closedAt: null,
        payloadHash,
        credentialVersion: credential.version,
      });
      await this.audit(tx, user.id, "password_login", at);
      return { ok: true, value: session };
    });
  }

  async resetPassword(input: {
    readonly handoffToken: string;
    readonly password: string;
    readonly idempotencyKey: string;
    readonly source?: string;
  }): Promise<AuthResult<{ readonly reset: true }>> {
    if (this.options.profile === "password-only")
      return fail("AUTH_CHANNEL_UNAVAILABLE");
    if (!validPassword(input.password)) return fail("AUTH_INVALID_PASSWORD");
    const tokenHash = await hashSessionToken(input.handoffToken),
      at = this.clock();
    const prepared = await this.transactional<{
      handoff: StoredHandoff;
      keyHash: string;
      receipt: StoredPasswordResetReceipt | null;
      credential: StoredPasswordCredential | null;
    }>(async (tx) => {
      const handoff = await tx.findHandoff(tokenHash);
      if (
        handoff === null ||
        handoff.purpose !== "password_reset" ||
        handoff.userId === null ||
        !this.handoffModeOk(handoff)
      )
        return fail("AUTH_PROOF_REJECTED");
      const keyHash = await this.receiptKey(
        input.idempotencyKey,
        tokenHash,
        "password_reset",
      );
      const receipt = await tx.findPasswordResetReceipt(keyHash);
      if (
        receipt?.closedAt != null ||
        (receipt === null &&
          (handoff.consumedAt !== null ||
            new Date(handoff.expiresAt).getTime() <= at.getTime()))
      )
        return fail("AUTH_PROOF_REJECTED");
      const credential = await tx.findPasswordCredential(handoff.userId);
      return {
        ok: true as const,
        value: { handoff, keyHash, receipt, credential },
      };
    });
    if (!prepared.ok) return prepared;
    const prior = prepared.value;
    const budget = await this.transactional((tx) =>
      this.reservePasswordAttempt(
        tx,
        prior.handoff.targetDigest,
        input.source ?? "unknown",
        at,
      ),
    );
    if (!budget.ok) return budget;
    let verifier: string;
    try {
      if (prior.receipt !== null) {
        if (
          prior.receipt.closedAt !== null ||
          prior.credential === null ||
          prior.receipt.credentialVersion !== prior.credential.version ||
          !(await verifyPassword(input.password, prior.credential.verifier))
        )
          return fail("AUTH_PROOF_REJECTED");
        verifier = prior.credential.verifier;
      } else verifier = await hashPassword(input.password);
    } catch (error) {
      if (error instanceof PasswordHashBusyError)
        return fail("AUTH_RATE_LIMITED");
      throw error;
    }
    const payloadHash = await keyedHash(
      this.options.keys.lookupKey,
      JSON.stringify([tokenHash, verifier]),
    );
    return this.convergeReceiptRace(
      () => this.resetPassword(input),
      () =>
        this.transactional(async (tx) => {
          const user = await tx.lockUser(prior.handoff.userId!);
          const handoff = await tx.findHandoff(tokenHash);
          if (
            user?.status !== "active" ||
            handoff === null ||
            handoff.purpose !== "password_reset" ||
            handoff.userId !== user.id ||
            !this.handoffModeOk(handoff)
          )
            return fail("AUTH_PROOF_REJECTED");
          const credential = await tx.findPasswordCredential(user.id);
          const receipt = await tx.findPasswordResetReceipt(prior.keyHash);
          if (receipt !== null) {
            if (prior.receipt === null) throw new PasswordReceiptRace();
            if (
              receipt.closedAt !== null ||
              receipt.payloadHash !== payloadHash ||
              receipt.credentialVersion !== credential?.version
            )
              return fail("AUTH_PROOF_REJECTED");
            return { ok: true, value: { reset: true as const } };
          }
          if (new Date(handoff.expiresAt).getTime() <= at.getTime())
            return fail("AUTH_CODE_EXPIRED");
          const identity = await tx.findIdentity(
            handoff.channel,
            handoff.targetDigest,
          );
          if (
            handoff.consumedAt !== null ||
            identity?.userId !== user.id ||
            identity.id !== handoff.identityId ||
            identity.version !== handoff.expectedVersion ||
            !this.provenanceOk(identity) ||
            (credential?.version ?? 0) !== handoff.credentialVersion
          )
            return fail("AUTH_PROOF_REJECTED");
          if ((await tx.consumeHandoff(handoff.id, at.toISOString())) !== "ok")
            return fail("AUTH_PROOF_REJECTED");
          const version = (credential?.version ?? 0) + 1;
          if (
            (await tx.savePasswordCredential(
              {
                userId: user.id,
                verifier,
                version,
                updatedAt: at.toISOString(),
              },
              credential?.version ?? null,
            )) !== "ok"
          )
            throw new AuthRollback(fail("AUTH_PROOF_REJECTED"));
          await tx.revokeAllSessions(user.id, at.toISOString());
          await tx.closeUserReceipts(user.id, at.toISOString());
          await tx.invalidatePasswordResetProofs(user.id, at.toISOString());
          if (
            (await tx.insertPasswordResetReceipt({
              keyHash: prior.keyHash,
              userId: user.id,
              payloadHash,
              credentialVersion: version,
              closedAt: null,
            })) !== "ok"
          )
            throw new AuthRollback(fail("AUTH_PROOF_REJECTED"));
          await this.audit(tx, user.id, "password_reset", at);
          return { ok: true, value: { reset: true as const } };
        }),
    );
  }

  private async convergeReceiptRace<T>(
    repeat: () => Promise<AuthResult<T>>,
    work: () => Promise<AuthResult<T>>,
  ): Promise<AuthResult<T>> {
    try {
      return await work();
    } catch (error) {
      // The transaction rolled back. Re-read and slow-verify the winner outside
      // DB locks; shared attempt reservations bound even concurrent retries.
      if (error instanceof PasswordReceiptRace) return repeat();
      throw error;
    }
  }

  private async reservePasswordAttempt(
    tx: AuthUnitOfWork,
    digest: string,
    requestSource: string,
    at: Date,
  ): Promise<AuthResult<true>> {
    await tx.lockDigest("password-login-attempts");
    const since = new Date(at.getTime() - WINDOW_MS).toISOString();
    const target = `password:${digest}`,
      source = await keyedHash(
        this.options.keys.lookupKey,
        `password-source\0${requestSource}`,
      );
    if (
      (await tx.sendCount("target", target, since)) >= TARGET_SENDS ||
      (await tx.sendCount("source", source, since)) >= SOURCE_SENDS ||
      (await tx.sendCount("global", "password-global", since)) >= GLOBAL_SENDS
    )
      return fail("AUTH_RATE_LIMITED");
    await tx.addSend("target", target, at.toISOString());
    await tx.addSend("source", source, at.toISOString());
    await tx.addSend("global", "password-global", at.toISOString());
    return { ok: true, value: true };
  }

  private registrationPayload(
    displayName: string,
    studioName: string,
    studioNameSuffix: string,
    verifier: string | null,
  ): Promise<string> {
    // Preserve exact replay of pre-suffix receipts; paired writes bind the suffix too.
    return keyedHash(
      this.options.keys.lookupKey,
      JSON.stringify(
        this.options.environment === "production"
          ? [
              "register-production",
              displayName,
              studioName,
              verifier,
              studioNameSuffix,
              this.registrationAgreement?.version,
            ]
          : studioNameSuffix === ""
            ? ["register", displayName, studioName, verifier]
            : ["register", displayName, studioName, verifier, studioNameSuffix],
      ),
    );
  }

  async readAccount(
    sessionToken: string,
  ): Promise<AuthResult<AuthAccountSecurity>> {
    const at = this.clock();
    const tokenHash = await hashSessionToken(sessionToken);
    return this.transactional(async (tx) => {
      const user = await tx.findSessionUser(
        tokenHash,
        at.toISOString(),
        this.requiredSessionEnvironment(),
      );
      if (user === null) return fail("AUTH_UNAUTHENTICATED");
      if (user.status !== "active") return fail("AUTH_ACCOUNT_SUSPENDED");
      return { ok: true, value: await this.accountView(tx, user.id) };
    });
  }

  async completeFactor(input: {
    readonly challengeId: string;
    readonly code: string;
    readonly continuationToken: string;
    readonly reauthToken: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly sessionToken: string;
  }): Promise<
    AuthResult<{
      readonly session: AuthSessionGrant;
      readonly account: AuthAccountSecurity;
    }>
  > {
    if (this.options.profile === "password-only")
      return fail("AUTH_CHANNEL_UNAVAILABLE");
    let at = this.clock();
    const continuationHash = await hashSessionToken(input.continuationToken);
    const sessionHash = await hashSessionToken(input.sessionToken);
    const reauthHash = await hashSessionToken(input.reauthToken);
    const payloadHash = await keyedHash(
      this.options.keys.lookupKey,
      JSON.stringify([
        "factor-completion",
        input.challengeId,
        continuationHash,
        reauthHash,
        input.code,
        input.expectedVersion,
      ]),
    );
    const loaded = await this.transactional<{
      challenge: StoredChallenge;
      checkProvider: boolean;
    }>(async (tx) => {
      const challenge = await tx.findChallenge(input.challengeId);
      if (challenge === null || challenge.continuationHash !== continuationHash)
        return fail("AUTH_PROOF_REJECTED");
      // Completed receipts are authorization recovery, not another OTP use.
      // The locked final transaction validates the exact payload and lineage.
      if (
        challenge.completedAt !== null &&
        (challenge.purpose === "link" || challenge.purpose === "replace") &&
        (await tx.findReceipt(
          await this.receiptKey(
            input.idempotencyKey,
            challenge.targetDigest,
            challenge.purpose,
          ),
        )) !== null
      )
        return { ok: true, value: { challenge, checkProvider: false } };
      let checkProvider = challenge.strategy === "provider_generated";
      if (checkProvider) {
        if (!this.challengeModeOk(challenge))
          return fail("AUTH_PROVENANCE_REJECTED");
        if (!this.challengeFresh(challenge, at))
          return this.staleChallenge(challenge, at);
        if (challenge.purpose !== "link" && challenge.purpose !== "replace")
          return fail("AUTH_PROOF_REJECTED");
        const user = await tx.findSessionUser(
          sessionHash,
          at.toISOString(),
          this.requiredSessionEnvironment(),
        );
        if (
          user === null ||
          challenge.userId !== user.id ||
          challenge.sessionHash !== sessionHash
        )
          return fail("AUTH_UNAUTHENTICATED");
        if (user.status !== "active") return fail("AUTH_ACCOUNT_SUSPENDED");
        const receipt = await tx.findReceipt(
          await this.receiptKey(
            input.idempotencyKey,
            challenge.targetDigest,
            challenge.purpose,
          ),
        );
        if (receipt !== null) checkProvider = false;
        else {
          const ready = await this.providerChallengeReady(tx, challenge, at);
          if (!ready.ok) return ready;
          const reauth = await tx.findHandoff(reauthHash);
          if (
            reauth === null ||
            reauth.purpose !== "reauth" ||
            reauth.userId !== user.id ||
            reauth.sessionHash !== sessionHash ||
            reauth.consumedAt !== null ||
            !this.handoffModeOk(reauth) ||
            new Date(reauth.expiresAt).getTime() <= at.getTime()
          )
            return fail("AUTH_PROOF_REJECTED");
          const identities = await tx.listIdentities(user.id);
          const reauthIdentity = identities.find(
            (row) => row.kind === reauth.channel,
          );
          if (
            reauthIdentity === undefined ||
            !this.provenanceOk(reauthIdentity)
          )
            return fail("AUTH_PROOF_REJECTED");
          const current = identities.find(
            (row) => row.kind === challenge.channel,
          );
          if (
            current === undefined
              ? challenge.purpose !== "link" || input.expectedVersion !== 0
              : challenge.purpose !== "replace" ||
                current.version !== input.expectedVersion
          )
            return fail("AUTH_STALE_VERSION");
          if (current !== undefined && !this.provenanceOk(current))
            return fail("AUTH_PROVENANCE_REJECTED");
          const owner = await tx.findIdentity(
            challenge.channel,
            challenge.targetDigest,
          );
          if (owner !== null && owner.userId !== user.id)
            return fail("AUTH_IDENTIFIER_CONFLICT");
        }
      }
      return { ok: true, value: { challenge, checkProvider } };
    });
    let providerPassed = false;
    let providerFailure: AuthReason | null = loaded.ok ? null : loaded.reason;
    if (loaded.ok && loaded.value.checkProvider) {
      const plain = await decryptContact(
        this.options.keys,
        loaded.value.challenge.channel,
        loaded.value.challenge.ciphertext,
      );
      if (plain === null) return fail("AUTH_PROOF_REJECTED");
      const checked = await this.options.delivery.checkPhone({
        e164: plain,
        code: input.code,
        outId: loaded.value.challenge.id,
      });
      if (checked === "unknown") providerFailure = "AUTH_DELIVERY_UNKNOWN";
      if (checked === "malformed") providerFailure = "AUTH_DELIVERY_FAILED";
      providerPassed = checked === "pass";
    }
    at = this.clock();
    return this.transactional(async (tx) => {
      // Serialize completion/recovery with logout, then reload observations
      // made before a concurrent completion or external provider call.
      const observed = await tx.findChallenge(input.challengeId);
      if (observed?.userId === null || observed === null)
        return fail("AUTH_PROOF_REJECTED");
      const currentUser = await tx.lockUser(observed.userId);
      const challenge = await tx.findChallenge(input.challengeId);
      if (
        currentUser === null ||
        challenge === null ||
        challenge.continuationHash !== continuationHash ||
        challenge.userId !== currentUser.id ||
        !this.challengeModeOk(challenge) ||
        (challenge.purpose !== "link" && challenge.purpose !== "replace")
      )
        return fail("AUTH_PROOF_REJECTED");
      if (currentUser.status !== "active")
        return fail("AUTH_ACCOUNT_SUSPENDED");
      const receiptKey = await this.receiptKey(
        input.idempotencyKey,
        challenge.targetDigest,
        challenge.purpose,
      );
      const receipt = await tx.findReceipt(receiptKey);
      if (receipt !== null) {
        if (
          challenge.completedAt === null ||
          challenge.sessionHash === null ||
          challenge.reauthHash !== reauthHash ||
          receipt.userId !== currentUser.id ||
          receipt.payloadHash !== payloadHash ||
          receipt.purpose !== `factor_change:${challenge.id}`
        )
          return fail("AUTH_PROOF_REJECTED");
        const caller = await tx.findSession(
          sessionHash,
          this.requiredSessionEnvironment(),
        );
        if (caller === null || caller.userId !== currentUser.id)
          return fail("AUTH_UNAUTHENTICATED");
        const source = await tx.lockSession(
          challenge.sessionHash,
          this.requiredSessionEnvironment(),
        );
        const presented =
          sessionHash === challenge.sessionHash
            ? source
            : await tx.lockSession(
                sessionHash,
                this.requiredSessionEnvironment(),
              );
        const lineage =
          presented === null
            ? null
            : await tx.findReceipt(
                await keyedHash(
                  this.options.keys.lookupKey,
                  `factor-lineage\0${receipt.keyHash}\0${presented.id}`,
                ),
              );
        const priorCookie =
          lineage !== null &&
          lineage.purpose === `factor_lineage:${receipt.keyHash}` &&
          lineage.userId === currentUser.id &&
          lineage.sessionId === presented?.id &&
          lineage.sessionTokenHash === sessionHash;
        if (
          source === null ||
          source.userId !== currentUser.id ||
          presented === null ||
          presented.userId !== currentUser.id ||
          new Date(presented.expiresAt).getTime() <= at.getTime() ||
          (presented.tokenHash !== challenge.sessionHash &&
            presented.id !== receipt.originSessionId &&
            presented.id !== receipt.sessionId &&
            !priorCookie)
        )
          return fail("AUTH_UNAUTHENTICATED");
        const proof = await tx.findHandoff(reauthHash);
        if (
          proof === null ||
          proof.purpose !== "reauth" ||
          proof.userId !== currentUser.id ||
          proof.sessionHash !== challenge.sessionHash ||
          proof.consumedAt === null ||
          !this.handoffModeOk(proof)
        )
          return fail("AUTH_PROOF_REJECTED");
        const session = await this.reissue(
          tx,
          receipt,
          currentUser,
          challenge.channel,
          at,
        );
        return {
          ok: true,
          value: {
            session,
            account: await this.accountView(tx, currentUser.id),
          },
        };
      }
      if (providerFailure !== null) return fail(providerFailure);
      if (challenge.reauthHash !== reauthHash)
        return fail("AUTH_PROOF_REJECTED");
      if (!this.challengeFresh(challenge, at))
        return fail("AUTH_PROOF_REJECTED");
      const user = await tx.findSessionUser(
        sessionHash,
        at.toISOString(),
        this.requiredSessionEnvironment(),
      );
      if (
        user === null ||
        challenge.userId !== user.id ||
        challenge.sessionHash !== sessionHash
      )
        return fail("AUTH_UNAUTHENTICATED");
      if (user.status !== "active") return fail("AUTH_ACCOUNT_SUSPENDED");
      const since = new Date(at.getTime() - WINDOW_MS).toISOString();
      if (
        (await tx.failureCount(
          challenge.targetDigest,
          challenge.purpose,
          since,
        )) >= MAX_ATTEMPTS ||
        challenge.attempts >= MAX_ATTEMPTS
      )
        return fail("AUTH_CODE_EXHAUSTED");
      if (!(await this.codeAccepted(challenge, input.code, providerPassed))) {
        await tx.saveChallenge({
          ...challenge,
          attempts: challenge.attempts + 1,
        });
        await tx.addFailure(
          challenge.targetDigest,
          challenge.purpose,
          at.toISOString(),
        );
        return fail("AUTH_CODE_INVALID");
      }
      const reauth = await tx.findHandoff(reauthHash);
      if (
        reauth === null ||
        reauth.purpose !== "reauth" ||
        reauth.userId !== user.id ||
        reauth.sessionHash !== sessionHash ||
        reauth.consumedAt !== null
      )
        return fail("AUTH_PROOF_REJECTED");
      if (
        !this.handoffModeOk(reauth) ||
        new Date(reauth.expiresAt).getTime() <= at.getTime()
      )
        return fail("AUTH_PROOF_REJECTED");
      const reauthIdentity = (await tx.listIdentities(user.id)).find(
        (row) => row.kind === reauth.channel,
      );
      if (reauthIdentity === undefined || !this.provenanceOk(reauthIdentity))
        return fail("AUTH_PROOF_REJECTED");
      const freshReauth = await tx.findHandoff(reauthHash);
      if (
        freshReauth === null ||
        freshReauth.consumedAt !== null ||
        freshReauth.userId !== user.id
      )
        return fail("AUTH_PROOF_REJECTED");
      const current = (await tx.listIdentities(user.id)).find(
        (row) => row.kind === challenge.channel,
      );
      const owner = await tx.findIdentity(
        challenge.channel,
        challenge.targetDigest,
      );
      if (owner !== null && owner.userId !== user.id)
        throw new AuthRollback(fail("AUTH_IDENTIFIER_CONFLICT"));
      if (current === undefined) {
        if (challenge.purpose !== "link" || input.expectedVersion !== 0)
          return fail("AUTH_STALE_VERSION");
        const inserted = await tx.insertIdentity(
          this.identityFrom(challenge, user.id, at),
        );
        if (inserted === "conflict")
          throw new AuthRollback(fail("AUTH_IDENTIFIER_CONFLICT"));
      } else {
        if (
          challenge.purpose !== "replace" ||
          current.version !== input.expectedVersion
        )
          return fail("AUTH_STALE_VERSION");
        if (
          current.verificationMode !== challenge.providerMode ||
          current.environment !== challenge.environment
        )
          return fail("AUTH_PROVENANCE_REJECTED");
        const replaced = await tx.replaceIdentity(
          {
            ...this.identityFrom(challenge, user.id, at),
            id: current.id,
            version: current.version + 1,
          },
          current.version,
        );
        if (replaced === "stale")
          throw new AuthRollback(fail("AUTH_STALE_VERSION"));
        if (replaced === "conflict")
          throw new AuthRollback(fail("AUTH_IDENTIFIER_CONFLICT"));
      }
      if ((await tx.consumeHandoff(freshReauth.id, at.toISOString())) !== "ok")
        throw new AuthRollback(fail("AUTH_PROOF_REJECTED"));
      await tx.saveChallenge({ ...challenge, completedAt: at.toISOString() });
      await tx.invalidateUserProofs(user.id, at.toISOString());
      const session = await this.mint(tx, user, challenge.channel, at);
      await tx.revokeOtherSessions(
        user.id,
        session.tokenHash,
        at.toISOString(),
      );
      await tx.insertReceipt({
        keyHash: receiptKey,
        userId: user.id,
        sessionId: session.sessionId,
        sessionTokenHash: session.tokenHash,
        purpose: `factor_change:${challenge.id}`,
        payloadHash,
        originSessionId: session.sessionId,
        closedAt: null,
      });
      await this.audit(tx, user.id, challenge.purpose, at);
      return {
        ok: true,
        value: { session, account: await this.accountView(tx, user.id) },
      };
    });
  }

  async unlinkFactor(input: {
    readonly channel: AuthChannelName;
    readonly reauthToken: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly sessionToken: string;
  }): Promise<
    AuthResult<{
      readonly session: AuthSessionGrant;
      readonly account: AuthAccountSecurity;
    }>
  > {
    if (this.options.profile === "password-only")
      return fail("AUTH_CHANNEL_UNAVAILABLE");
    const at = this.clock();
    const sessionHash = await hashSessionToken(input.sessionToken);
    const reauthHash = await hashSessionToken(input.reauthToken);
    return this.transactional(async (tx) => {
      const observed = await tx.findSession(
        sessionHash,
        this.requiredSessionEnvironment(),
      );
      if (observed === null) return fail("AUTH_UNAUTHENTICATED");
      await tx.lockUser(observed.userId);
      const user = await tx.findSessionUser(
        sessionHash,
        at.toISOString(),
        this.requiredSessionEnvironment(),
      );
      if (user === null) return fail("AUTH_UNAUTHENTICATED");
      if (user.status !== "active") return fail("AUTH_ACCOUNT_SUSPENDED");
      const receiptKey = await this.receiptKey(
        input.idempotencyKey,
        user.id,
        `unlink:${input.channel}`,
      );
      const receipt = await tx.findReceipt(receiptKey);
      if (receipt !== null) {
        const session = await this.reissue(
          tx,
          receipt,
          user,
          input.channel,
          at,
        );
        return {
          ok: true,
          value: { session, account: await this.accountView(tx, user.id) },
        };
      }
      const reauth = await tx.findHandoff(reauthHash);
      if (
        reauth === null ||
        reauth.purpose !== "reauth" ||
        reauth.userId !== user.id ||
        reauth.sessionHash !== sessionHash ||
        reauth.consumedAt !== null ||
        !this.handoffModeOk(reauth)
      )
        return fail("AUTH_PROOF_REJECTED");
      const freshReauth = await tx.findHandoff(reauthHash);
      if (
        freshReauth === null ||
        freshReauth.consumedAt !== null ||
        freshReauth.userId !== user.id ||
        freshReauth.purpose !== "reauth"
      )
        return fail("AUTH_PROOF_REJECTED");
      const identities = await tx.listIdentities(user.id);
      const reauthIdentity = identities.find(
        (row) => row.kind === reauth.channel,
      );
      if (reauthIdentity === undefined || !this.provenanceOk(reauthIdentity))
        return fail("AUTH_PROOF_REJECTED");
      const target = identities.find((row) => row.kind === input.channel);
      if (target === undefined) return fail("AUTH_INVALID_IDENTIFIER");
      if (target.version !== input.expectedVersion)
        return fail("AUTH_STALE_VERSION");
      const remaining = identities.filter(
        (row) => row.kind !== input.channel && this.provenanceOk(row),
      );
      if (remaining.length === 0) return fail("AUTH_LAST_FACTOR");
      const deleted = await tx.deleteIdentity(
        user.id,
        input.channel,
        input.expectedVersion,
      );
      if (deleted === "last_factor") return fail("AUTH_LAST_FACTOR");
      if (deleted === "stale") return fail("AUTH_STALE_VERSION");
      if (deleted !== "ok") return fail("AUTH_PROOF_REJECTED");
      if ((await tx.consumeHandoff(freshReauth.id, at.toISOString())) !== "ok")
        throw new AuthRollback(fail("AUTH_PROOF_REJECTED"));
      await tx.invalidateUserProofs(user.id, at.toISOString());
      const session = await this.mint(
        tx,
        user,
        remaining[0]?.kind ?? input.channel,
        at,
      );
      await tx.revokeOtherSessions(
        user.id,
        session.tokenHash,
        at.toISOString(),
      );
      await tx.insertReceipt({
        keyHash: receiptKey,
        userId: user.id,
        sessionId: session.sessionId,
        sessionTokenHash: session.tokenHash,
        purpose: "unlink",
        originSessionId: session.sessionId,
        closedAt: null,
      });
      await this.audit(tx, user.id, "unlink", at);
      return {
        ok: true,
        value: { session, account: await this.accountView(tx, user.id) },
      };
    });
  }

  async signOut(
    sessionToken: string,
  ): Promise<AuthResult<{ readonly signedOut: true }>> {
    const at = this.clock();
    const tokenHash = await hashSessionToken(sessionToken);
    return this.transactional(async (tx) => {
      const observed = await tx.findSession(
        tokenHash,
        this.requiredSessionEnvironment(),
      );
      if (observed === null) return fail("AUTH_UNAUTHENTICATED");
      await tx.lockUser(observed.userId);
      const session = await tx.lockSession(
        tokenHash,
        this.requiredSessionEnvironment(),
      );
      if (session === null) return fail("AUTH_UNAUTHENTICATED");
      if (
        session.revokedAt === null &&
        new Date(session.expiresAt).getTime() <= at.getTime()
      )
        return fail("AUTH_UNAUTHENTICATED");
      if (session.revokedAt !== null) {
        const open = (await tx.lockReceiptsForSession(session.id)).filter(
          (row) => row.closedAt === null,
        );
        if (open.length === 0) return fail("AUTH_UNAUTHENTICATED");
        for (const receipt of open)
          await this.sealReceipt(tx, receipt, tokenHash, at);
        return { ok: true, value: { signedOut: true } };
      }
      if (!(await tx.revokeSession(tokenHash, at.toISOString())))
        return fail("AUTH_UNAUTHENTICATED");
      for (const receipt of await tx.lockReceiptsForSession(session.id))
        await this.sealReceipt(tx, receipt, tokenHash, at);
      return { ok: true, value: { signedOut: true } };
    });
  }

  private async finishVerify(
    tx: AuthUnitOfWork,
    input: {
      readonly challengeId: string;
      readonly code: string;
      readonly idempotencyKey: string;
    },
    continuationHash: string,
    providerPassed: boolean,
    at: Date,
  ): Promise<AuthResult<AuthVerifyValue>> {
    let challenge = await tx.findChallenge(input.challengeId);
    if (challenge === null || challenge.continuationHash !== continuationHash)
      return fail("AUTH_PROOF_REJECTED");
    if (!this.challengeModeOk(challenge))
      return fail("AUTH_PROVENANCE_REJECTED");
    const receiptKey = await this.receiptKey(
      input.idempotencyKey,
      challenge.targetDigest,
      challenge.purpose,
    );
    const receipt = await tx.findReceipt(receiptKey);
    const targetIdentity = await tx.findIdentity(
      challenge.channel,
      challenge.targetDigest,
    );
    // Reset owns User -> Challenge -> Session/receipt order. Acquire all known
    // users deterministically before touching a challenge; never trust the first read.
    const userIds = new Set([
      challenge.userId,
      targetIdentity?.userId ?? null,
      receipt !== null && challenge.purpose === "sign_in"
        ? receipt.userId
        : null,
    ]);
    for (const id of [...userIds]
      .filter((id): id is string => id !== null)
      .sort())
      await tx.lockUser(id);
    if (targetIdentity === null) await tx.lockDigest(challenge.targetDigest);
    const identity = await tx.findIdentity(
      challenge.channel,
      challenge.targetDigest,
    );
    // Ownership may change before the first User lock. Reject that stale read
    // before touching Challenge; discovering and locking a new owner afterward
    // would reverse the reset User -> Challenge order.
    if (
      identity?.id !== targetIdentity?.id ||
      identity?.userId !== targetIdentity?.userId ||
      identity?.version !== targetIdentity?.version ||
      identity?.environment !== targetIdentity?.environment ||
      identity?.verificationMode !== targetIdentity?.verificationMode
    )
      return fail("AUTH_PROOF_REJECTED");
    challenge = await tx.findChallenge(input.challengeId);
    if (challenge === null || challenge.continuationHash !== continuationHash)
      return fail("AUTH_PROOF_REJECTED");
    if (!this.challengeModeOk(challenge))
      return fail("AUTH_PROVENANCE_REJECTED");
    if (challenge.invalidatedAt !== null || challenge.supersededAt !== null)
      return this.staleChallenge(challenge, at);
    if (receipt !== null && challenge.purpose === "sign_in") {
      const user = await tx.lockUser(receipt.userId);
      if (user === null || user.status !== "active")
        return fail("AUTH_ACCOUNT_SUSPENDED");
      return {
        ok: true,
        value: {
          outcome: "signed_in",
          session: await this.reissue(tx, receipt, user, challenge.channel, at),
        },
      };
    }
    if (!this.challengeFresh(challenge, at))
      return this.staleChallenge(challenge, at);
    const since = new Date(at.getTime() - WINDOW_MS).toISOString();
    if (
      (await tx.failureCount(
        challenge.targetDigest,
        challenge.purpose,
        since,
      )) >= MAX_ATTEMPTS ||
      challenge.attempts >= MAX_ATTEMPTS
    )
      return fail("AUTH_CODE_EXHAUSTED");
    if (!(await this.codeAccepted(challenge, input.code, providerPassed))) {
      await tx.saveChallenge({
        ...challenge,
        attempts: challenge.attempts + 1,
      });
      await tx.addFailure(
        challenge.targetDigest,
        challenge.purpose,
        at.toISOString(),
      );
      return fail("AUTH_CODE_INVALID");
    }
    // Link and replace are completed only by completeFactor. Verifying them
    // here must not set completedAt, or that proof can never be used.
    if (challenge.purpose === "link" || challenge.purpose === "replace")
      return fail("AUTH_PROOF_REJECTED");
    if (
      (challenge.purpose === "register" ||
        (challenge.purpose === "sign_in" && identity === null)) &&
      !this.registrationAvailable()
    )
      return fail("AUTH_NOT_CONFIGURED");
    await tx.saveChallenge({ ...challenge, completedAt: at.toISOString() });
    if (challenge.purpose === "reauthenticate") {
      if (challenge.userId === null || challenge.sessionHash === null)
        return fail("AUTH_PROOF_REJECTED");
      const token = generateSessionToken(this.randomBytes);
      await tx.insertHandoff({
        id: generateOpaqueId("handoff", this.randomBytes),
        tokenHash: await hashSessionToken(token),
        purpose: "reauth",
        channel: challenge.channel,
        targetDigest: challenge.targetDigest,
        ciphertext: challenge.ciphertext,
        providerMode: challenge.providerMode,
        environment: challenge.environment,
        userId: challenge.userId,
        sessionHash: challenge.sessionHash,
        expectedVersion: challenge.expectedVersion,
        expiresAt: new Date(at.getTime() + HANDOFF_TTL_MS).toISOString(),
        consumedAt: null,
      });
      return {
        ok: true,
        value: { outcome: "reauthenticated", reauthToken: token },
      };
    }
    if (challenge.purpose === "password_reset") {
      const user =
        challenge.userId === null ? null : await tx.lockUser(challenge.userId);
      const credential =
        user === null ? null : await tx.findPasswordCredential(user.id);
      if (
        user?.status !== "active" ||
        identity?.userId !== user.id ||
        identity.id !== challenge.identityId ||
        identity.version !== challenge.expectedVersion ||
        !this.provenanceOk(identity) ||
        (credential?.version ?? 0) !== challenge.credentialVersion
      )
        return fail("AUTH_PROOF_REJECTED");
      const token = generateSessionToken(this.randomBytes);
      await tx.insertHandoff({
        id: generateOpaqueId("handoff", this.randomBytes),
        tokenHash: await hashSessionToken(token),
        purpose: "password_reset",
        channel: challenge.channel,
        targetDigest: challenge.targetDigest,
        ciphertext: challenge.ciphertext,
        providerMode: challenge.providerMode,
        environment: challenge.environment,
        userId: user.id,
        sessionHash: null,
        expectedVersion: identity.version,
        identityId: identity.id,
        credentialVersion: credential?.version ?? 0,
        expiresAt: new Date(at.getTime() + HANDOFF_TTL_MS).toISOString(),
        consumedAt: null,
      });
      const plain = await decryptContact(
        this.options.keys,
        challenge.channel,
        challenge.ciphertext,
      );
      if (plain === null) return fail("AUTH_PROOF_REJECTED");
      return {
        ok: true,
        value: {
          outcome: "password_reset_required",
          handoffToken: token,
          channel: challenge.channel,
          maskedTarget:
            challenge.channel === "email" ? maskEmail(plain) : maskPhone(plain),
        },
      };
    }
    if (challenge.purpose === "register") {
      if (identity !== null)
        return {
          ok: true,
          value: { outcome: "already_registered", channel: challenge.channel },
        };
      return this.issueRegistrationHandoff(tx, challenge, at);
    }
    if (challenge.purpose !== "sign_in") return fail("AUTH_PROOF_REJECTED");
    if (identity === null)
      return this.issueRegistrationHandoff(tx, challenge, at);
    const user = await tx.lockUser(identity.userId);
    if (user === null || user.status !== "active")
      return fail("AUTH_ACCOUNT_SUSPENDED");
    if (!this.provenanceOk(identity)) return fail("AUTH_PROVENANCE_REJECTED");
    const session = await this.mint(tx, user, challenge.channel, at);
    await tx.insertReceipt({
      keyHash: receiptKey,
      userId: user.id,
      sessionId: session.sessionId,
      sessionTokenHash: session.tokenHash,
      purpose: "sign_in",
      originSessionId: session.sessionId,
      closedAt: null,
    });
    await this.audit(tx, user.id, "sign_in", at);
    return { ok: true, value: { outcome: "signed_in", session } };
  }

  private async reserve(
    tx: AuthUnitOfWork,
    input: {
      readonly channel: AuthChannelName;
      readonly purpose: AuthPurposeName;
      readonly idempotencyKey: string;
      readonly source: string;
    },
    target: Target,
    at: Date,
  ): Promise<AuthResult<Reservation>> {
    const since = new Date(at.getTime() - WINDOW_MS).toISOString();
    if (
      (await tx.failureCount(target.digest, input.purpose, since)) >=
      MAX_ATTEMPTS
    )
      return fail("AUTH_CODE_EXHAUSTED");
    const idempotencyHash = await keyedHash(
      this.options.keys.lookupKey,
      `send\0${input.purpose}\0${input.channel}\0${target.digest}\0${input.idempotencyKey}\0${target.sessionHash ?? ""}`,
    );
    const existing = await tx.findChallengeByIdempotency(idempotencyHash);
    if (existing !== null) {
      if (existing.deliveryState === "failed")
        return fail("AUTH_DELIVERY_FAILED");
      if (existing.deliveryState === "unknown")
        return fail("AUTH_DELIVERY_UNKNOWN");
      return {
        ok: true,
        value: {
          kind: "replay",
          accepted: {
            challengeId: existing.id,
            resendAvailableAt: existing.resendAvailableAt,
            maskedTarget: target.masked,
          },
        },
      };
    }
    const open = await tx.openChallenge({
      channel: input.channel,
      purpose: input.purpose,
      targetDigest: target.digest,
    });
    if (
      open !== null &&
      new Date(open.resendAvailableAt).getTime() > at.getTime()
    ) {
      return {
        ok: true,
        value: {
          kind: "replay",
          accepted: {
            challengeId: open.id,
            resendAvailableAt: open.resendAvailableAt,
            maskedTarget: target.masked,
          },
        },
      };
    }
    const sourceKey = await keyedHash(
      this.options.keys.lookupKey,
      `source\0${input.source}`,
    );
    if (
      (await tx.sendCount("target", target.digest, since)) >= TARGET_SENDS ||
      (await tx.sendCount("source", sourceKey, since)) >= SOURCE_SENDS ||
      (await tx.sendCount("global", "global", since)) >= GLOBAL_SENDS
    )
      return fail("AUTH_RATE_LIMITED");
    if (open !== null)
      await tx.saveChallenge({ ...open, supersededAt: at.toISOString() });
    const mode = this.modeFor(input.channel);
    if (mode === "disabled") return fail("AUTH_CHANNEL_UNAVAILABLE");
    const strategy =
      mode === "provider" && input.channel === "phone"
        ? "provider_generated"
        : "application_otp";
    const code = strategy === "application_otp" ? generateEmailOtp() : null;
    const id = generateOpaqueId("challenge", this.randomBytes);
    const continuationToken = generateSessionToken(this.randomBytes);
    const challenge: StoredChallenge = {
      id,
      channel: input.channel,
      purpose: input.purpose,
      targetDigest: target.digest,
      ciphertext: target.ciphertext,
      verifier:
        code === null
          ? null
          : await otpVerifier(
              this.options.keys,
              id,
              input.purpose,
              target.digest,
              code,
            ),
      strategy,
      providerMode: mode,
      environment: this.options.environment,
      userId: target.userId,
      sessionHash: target.sessionHash,
      continuationHash: await hashSessionToken(continuationToken),
      expectedVersion: target.expectedVersion,
      identityId: target.identityId ?? null,
      credentialVersion: target.credentialVersion ?? null,
      reauthHash: target.reauthHash,
      providerCorrelation: null,
      expiresAt: new Date(at.getTime() + OTP_TTL_MS).toISOString(),
      attempts: 0,
      resendAvailableAt: new Date(at.getTime() + RESEND_MS).toISOString(),
      supersededAt: null,
      completedAt: null,
      invalidatedAt: null,
      deliveryState: "pending",
      idempotencyHash,
      createdAt: at.toISOString(),
    };
    if ((await tx.insertChallenge(challenge)) === "conflict") {
      const raced = await tx.findChallengeByIdempotency(idempotencyHash);
      if (raced === null) return fail("AUTH_RATE_LIMITED");
      return {
        ok: true,
        value: {
          kind: "replay",
          accepted: {
            challengeId: raced.id,
            resendAvailableAt: raced.resendAvailableAt,
            maskedTarget: target.masked,
          },
        },
      };
    }
    await tx.addSend("target", target.digest, at.toISOString());
    await tx.addSend("source", sourceKey, at.toISOString());
    await tx.addSend("global", "global", at.toISOString());
    return {
      ok: true,
      value: {
        kind: "send",
        challenge,
        continuationToken,
        destination: target.destination,
        code,
      },
    };
  }

  private async resolveTarget(
    input: {
      readonly channel: AuthChannelName;
      readonly purpose: AuthPurposeName;
      readonly identifier?: string | undefined;
      readonly sessionToken?: string | undefined;
      readonly reauthToken?: string | undefined;
    },
    session: { readonly user: StoredUser; readonly sessionHash: string } | null,
    at: Date,
  ): Promise<AuthResult<Target>> {
    if (
      input.purpose === "reauthenticate" ||
      input.purpose === "link" ||
      input.purpose === "replace"
    ) {
      if (session === null) return fail("AUTH_UNAUTHENTICATED");
      if (session.user.status !== "active")
        return fail("AUTH_ACCOUNT_SUSPENDED");
    }
    if (input.purpose === "reauthenticate") {
      if (session === null) return fail("AUTH_UNAUTHENTICATED");
      return this.transactional(async (tx) => {
        const identity = (await tx.listIdentities(session.user.id)).find(
          (row) => row.kind === input.channel,
        );
        if (identity === undefined || !this.provenanceOk(identity))
          return fail("AUTH_INVALID_IDENTIFIER");
        const destination = await decryptContact(
          this.options.keys,
          input.channel,
          identity.ciphertext,
        );
        if (destination === null) return fail("AUTH_PROOF_REJECTED");
        return {
          ok: true,
          value: {
            digest: identity.lookupDigest,
            destination,
            masked:
              input.channel === "email"
                ? maskEmail(destination)
                : maskPhone(destination),
            ciphertext: identity.ciphertext,
            userId: session.user.id,
            sessionHash: session.sessionHash,
            expectedVersion: identity.version,
            reauthHash: null,
          },
        };
      });
    }
    const normalized = this.normalize(input.channel, input.identifier ?? "");
    if (normalized === null) return fail("AUTH_INVALID_IDENTIFIER");
    if (input.purpose === "password_reset") {
      const digest = await lookupDigest(
        input.channel,
        normalized.lookup,
        this.options.keys,
      );
      return this.transactional(async (tx) => {
        const identity = await tx.findIdentity(input.channel, digest);
        const credential =
          identity === null
            ? null
            : await tx.findPasswordCredential(identity.userId);
        return {
          ok: true,
          value: {
            digest,
            destination: normalized.delivery,
            masked: normalized.masked,
            ciphertext: await encryptContact(
              this.options.keys,
              input.channel,
              normalized.delivery,
            ),
            userId: identity?.userId ?? null,
            sessionHash: null,
            reauthHash: null,
            identityId: identity?.id ?? null,
            expectedVersion: identity?.version ?? null,
            credentialVersion: credential?.version ?? 0,
          },
        };
      });
    }
    let reauthHash: string | null = null;
    if (input.purpose === "link" || input.purpose === "replace") {
      if (session === null || input.reauthToken === undefined)
        return fail("AUTH_PROOF_REJECTED");
      reauthHash = await hashSessionToken(input.reauthToken);
      const reauth = await this.transactional<StoredHandoff>(async (tx) => {
        const row = await tx.findHandoff(reauthHash ?? "");
        if (row === null) return fail("AUTH_PROOF_REJECTED");
        return { ok: true, value: row };
      });
      if (!reauth.ok) return reauth;
      if (
        reauth.value.purpose !== "reauth" ||
        reauth.value.userId !== session.user.id ||
        reauth.value.sessionHash !== session.sessionHash ||
        reauth.value.consumedAt !== null ||
        new Date(reauth.value.expiresAt).getTime() <= at.getTime()
      )
        return fail("AUTH_PROOF_REJECTED");
    }
    return {
      ok: true,
      value: {
        digest: await lookupDigest(
          input.channel,
          normalized.lookup,
          this.options.keys,
        ),
        destination: normalized.delivery,
        masked: normalized.masked,
        ciphertext: await encryptContact(
          this.options.keys,
          input.channel,
          normalized.delivery,
        ),
        userId: session?.user.id ?? null,
        sessionHash: session?.sessionHash ?? null,
        expectedVersion: null,
        reauthHash,
      },
    };
  }

  private async optionalSession(
    token: string | undefined,
    at: Date,
  ): Promise<
    AuthResult<{
      readonly user: StoredUser;
      readonly sessionHash: string;
    } | null>
  > {
    if (token === undefined) return { ok: true, value: null };
    const sessionHash = await hashSessionToken(token);
    return this.transactional(async (tx) => {
      const user = await tx.findSessionUser(
        sessionHash,
        at.toISOString(),
        this.requiredSessionEnvironment(),
      );
      if (user === null) return fail("AUTH_UNAUTHENTICATED");
      return { ok: true, value: { user, sessionHash } };
    });
  }

  private async issueRegistrationHandoff(
    tx: AuthUnitOfWork,
    challenge: StoredChallenge,
    at: Date,
  ): Promise<AuthResult<AuthVerifyValue>> {
    const token = generateSessionToken(this.randomBytes);
    await tx.insertHandoff({
      id: generateOpaqueId("handoff", this.randomBytes),
      tokenHash: await hashSessionToken(token),
      purpose: "register_confirm",
      channel: challenge.channel,
      targetDigest: challenge.targetDigest,
      ciphertext: challenge.ciphertext,
      providerMode: challenge.providerMode,
      environment: challenge.environment,
      userId: null,
      sessionHash: null,
      expectedVersion: null,
      expiresAt: new Date(at.getTime() + HANDOFF_TTL_MS).toISOString(),
      consumedAt: null,
    });
    const plain = await decryptContact(
      this.options.keys,
      challenge.channel,
      challenge.ciphertext,
    );
    return {
      ok: true,
      value: {
        outcome: "registration_required",
        handoffToken: token,
        maskedTarget:
          plain === null
            ? "***"
            : challenge.channel === "email"
              ? maskEmail(plain)
              : maskPhone(plain),
        channel: challenge.channel,
      },
    };
  }

  private async deliver(
    reserved: Extract<Reservation, { kind: "send" }>,
  ): Promise<DeliveryOutcome> {
    try {
      if (reserved.challenge.channel === "email") {
        if (reserved.code === null) return { state: "failed" };
        return await this.options.delivery.sendEmail({
          to: reserved.destination,
          code: reserved.code,
          minutes: 5,
        });
      }
      return await this.options.delivery.sendPhone({
        e164: reserved.destination,
        code: reserved.code,
        outId: reserved.challenge.id,
        minutes: 5,
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      return name === "TimeoutError" || name === "AbortError"
        ? { state: "unknown" }
        : { state: "failed" };
    }
  }

  private async codeAccepted(
    challenge: StoredChallenge,
    code: string,
    providerPassed: boolean,
  ): Promise<boolean> {
    if (challenge.strategy === "provider_generated") return providerPassed;
    if (challenge.verifier === null) return false;
    return verifierMatches(
      challenge.verifier,
      await otpVerifier(
        this.options.keys,
        challenge.id,
        challenge.purpose,
        challenge.targetDigest,
        code,
      ),
    );
  }

  private async mint(
    tx: AuthUnitOfWork,
    user: StoredUser,
    channel: AuthChannelName | "password",
    at: Date,
  ): Promise<Minted> {
    const token = generateSessionToken(this.randomBytes);
    const tokenHash = await hashSessionToken(token);
    const sessionId = generateOpaqueId("session", this.randomBytes);
    const expiresAt = new Date(at.getTime() + this.sessionTtlMs).toISOString();
    await tx.insertSession({
      id: sessionId,
      tokenHash,
      userId: user.id,
      issuedAt: at.toISOString(),
      expiresAt,
      issuer: channel === "password" ? "password_login" : "verified_login",
      authEnvironment: this.options.environment,
      authChannel: channel === "password" ? null : channel,
    });
    return {
      token,
      expiresAt,
      profile: mapPublicUserProfile({
        id: user.id as PublicUserId,
        handle: user.handle,
        displayName: user.displayName,
        ...(user.studioName === undefined
          ? {}
          : { studioName: user.studioName }),
        status: user.status,
      }),
      sessionId,
      tokenHash,
    };
  }

  private async sealReceipt(
    tx: AuthUnitOfWork,
    receipt: StoredReceipt,
    presentedHash: string,
    at: Date,
  ): Promise<void> {
    if (receipt.closedAt === null)
      await tx.closeReceipt(receipt.keyHash, at.toISOString());
    if (receipt.sessionTokenHash !== presentedHash)
      await tx.revokeSession(receipt.sessionTokenHash, at.toISOString());
  }

  private async reissue(
    tx: AuthUnitOfWork,
    receipt: StoredReceipt,
    user: StoredUser,
    channel: AuthChannelName | "password",
    at: Date,
  ): Promise<AuthSessionGrant> {
    const bound = await tx.lockSession(
      receipt.sessionTokenHash,
      this.requiredSessionEnvironment(),
    );
    const locked = await tx.lockReceipt(receipt.keyHash);
    const live =
      bound !== null &&
      bound.userId === user.id &&
      locked?.userId === user.id &&
      bound.tokenHash === locked.sessionTokenHash &&
      bound.revokedAt === null &&
      new Date(bound.expiresAt).getTime() > at.getTime();
    if (locked === null || locked.closedAt !== null || !live)
      throw new AuthRollback(fail("AUTH_PROOF_REJECTED"));
    if (!(await tx.revokeSession(locked.sessionTokenHash, at.toISOString())))
      throw new AuthRollback(fail("AUTH_PROOF_REJECTED"));
    const session = await this.mint(tx, user, channel, at);
    if (locked.purpose.startsWith("factor_change:")) {
      // Hash-only receipt lineage, not a second Session store. Keep every
      // previously returned cookie able to close the canonical receipt.
      await tx.insertReceipt({
        keyHash: await keyedHash(
          this.options.keys.lookupKey,
          `factor-lineage\0${locked.keyHash}\0${bound.id}`,
        ),
        userId: locked.userId,
        sessionId: bound.id,
        sessionTokenHash: bound.tokenHash,
        purpose: `factor_lineage:${locked.keyHash}`,
        originSessionId: bound.id,
        closedAt: null,
      });
    }
    await tx.updateReceiptSession(
      locked.keyHash,
      session.sessionId,
      session.tokenHash,
    );
    return session;
  }

  private async insertNewUser(
    tx: AuthUnitOfWork,
    displayName: string,
    studioName = "",
    studioNameSuffix = "",
  ): Promise<StoredUser> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const user: StoredUser = {
        id: generateOpaqueId("user", this.randomBytes),
        handle: this.generateHandle(),
        displayName,
        studioName,
        studioNameSuffix,
        status: "active",
      };
      if ((await tx.insertUser(user)) === "ok") return user;
    }
    throw new Error("Could not assign a handle");
  }

  private async accountView(
    tx: AuthUnitOfWork,
    userId: string,
  ): Promise<AuthAccountSecurity> {
    const identities = await tx.listIdentities(userId);
    const factor = async (channel: AuthChannelName): Promise<AuthFactor> => {
      const identity = identities.find((row) => row.kind === channel);
      if (identity === undefined)
        return {
          channel,
          state: "unbound",
          masked: null,
          version: 0,
          usable: false,
        };
      const plain = await decryptContact(
        this.options.keys,
        channel,
        identity.ciphertext,
      );
      const masked =
        plain === null
          ? "***"
          : channel === "email"
            ? maskEmail(plain)
            : maskPhone(plain);
      const usable = this.provenanceOk(identity);
      const pending = await tx.hasOpenFactorChange(userId, channel);
      const state = !this.channelAvailable(channel)
        ? "unavailable"
        : pending
          ? "pending"
          : "verified";
      return { channel, state, masked, version: identity.version, usable };
    };
    return {
      userId,
      email: await factor("email"),
      phone: await factor("phone"),
      capabilities: this.capabilities(),
    };
  }

  private async audit(
    tx: AuthUnitOfWork,
    userId: string,
    action: string,
    at: Date,
  ): Promise<void> {
    await tx.insertAudit({
      id: generateOpaqueId("auth-audit", this.randomBytes),
      userId,
      action,
      atIso: at.toISOString(),
    });
  }

  private identityFrom(
    challenge: StoredChallenge,
    userId: string,
    at: Date,
  ): StoredIdentity {
    return {
      id: generateOpaqueId("login", this.randomBytes),
      userId,
      kind: challenge.channel,
      lookupDigest: challenge.targetDigest,
      ciphertext: challenge.ciphertext,
      lookupKeyVersion: this.options.keys.version,
      verificationMode: challenge.providerMode,
      environment: challenge.environment,
      version: 1,
      verifiedAt: at.toISOString(),
    };
  }

  /** Read-only refusal before a live provider call; final transaction rechecks races. */
  private async providerChallengeReady(
    tx: AuthUnitOfWork,
    challenge: StoredChallenge,
    at: Date,
  ): Promise<AuthResult<true>> {
    if (!this.challengeModeOk(challenge))
      return fail("AUTH_PROVENANCE_REJECTED");
    if (!this.challengeFresh(challenge, at))
      return this.staleChallenge(challenge, at);
    const since = new Date(at.getTime() - WINDOW_MS).toISOString();
    if (
      challenge.attempts >= MAX_ATTEMPTS ||
      (await tx.failureCount(
        challenge.targetDigest,
        challenge.purpose,
        since,
      )) >= MAX_ATTEMPTS
    )
      return fail("AUTH_CODE_EXHAUSTED");
    return { ok: true, value: true };
  }

  private staleChallenge(
    challenge: StoredChallenge,
    at: Date,
  ): AuthResult<never> {
    if (challenge.supersededAt !== null) return fail("AUTH_CODE_SUPERSEDED");
    if (new Date(challenge.expiresAt).getTime() <= at.getTime())
      return fail("AUTH_CODE_EXPIRED");
    return fail("AUTH_PROOF_REJECTED");
  }

  private challengeFresh(challenge: StoredChallenge, at: Date): boolean {
    return (
      challenge.supersededAt === null &&
      challenge.invalidatedAt === null &&
      challenge.completedAt === null &&
      challenge.deliveryState === "accepted" &&
      new Date(challenge.expiresAt).getTime() > at.getTime()
    );
  }

  private normalize(
    channel: AuthChannelName,
    identifier: string,
  ): {
    readonly lookup: string;
    readonly delivery: string;
    readonly masked: string;
  } | null {
    if (channel === "email") {
      const email = normalizeEmail(identifier);
      if (email === null) return null;
      return {
        lookup: email.lookup,
        delivery: email.delivery,
        masked: maskEmail(email.delivery),
      };
    }
    const phone = normalizePhone(identifier);
    if (phone === null) return null;
    return { lookup: phone, delivery: phone, masked: maskPhone(phone) };
  }

  private requiredSessionEnvironment(): "production" | undefined {
    return this.options.environment === "production" ? "production" : undefined;
  }

  private registrationAvailable(): boolean {
    return (
      this.options.profile !== "password-only" &&
      (this.options.environment !== "production" ||
        this.registrationAgreement !== null)
    );
  }

  private channelAvailable(channel: AuthChannelName): boolean {
    return (
      this.options.profile !== "password-only" &&
      this.modeFor(channel) !== "disabled"
    );
  }

  private modeFor(channel: AuthChannelName): VerificationMode | "disabled" {
    return channel === "email"
      ? this.options.emailMode
      : this.options.phoneMode;
  }

  private provenanceOk(identity: StoredIdentity): boolean {
    return (
      identity.environment === this.options.environment &&
      identity.verificationMode === this.modeFor(identity.kind)
    );
  }

  private challengeModeOk(challenge: StoredChallenge): boolean {
    return (
      challenge.environment === this.options.environment &&
      challenge.providerMode === this.modeFor(challenge.channel)
    );
  }

  private handoffModeOk(handoff: StoredHandoff): boolean {
    return (
      handoff.environment === this.options.environment &&
      handoff.providerMode === this.modeFor(handoff.channel)
    );
  }

  private async receiptKey(
    idempotencyKey: string,
    target: string,
    purpose: string,
  ): Promise<string> {
    return await keyedHash(
      this.options.keys.lookupKey,
      `receipt\0${purpose}\0${target}\0${idempotencyKey}`,
    );
  }

  private generateHandle(): string {
    const bytes = this.randomBytes(12);
    let handle = "u";
    for (const byte of bytes)
      handle += HANDLE_ALPHABET[byte % HANDLE_ALPHABET.length] ?? "a";
    return handle;
  }

  private async transactional<T>(
    work: (tx: AuthUnitOfWork) => Promise<AuthResult<T>>,
  ): Promise<AuthResult<T>> {
    try {
      return await this.port.transaction(work);
    } catch (error) {
      if (error instanceof AuthRollback) return error.result as AuthResult<T>;
      if (attemptsBound(error)) return fail("AUTH_CODE_EXHAUSTED");
      throw error;
    }
  }
}
