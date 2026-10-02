export type AuthChannelName = "email" | "phone";
export type AuthPurposeName =
  | "sign_in"
  | "register"
  | "link"
  | "replace"
  | "reauthenticate"
  | "password_reset";
export type VerificationMode = "local_capture" | "simulated" | "provider";
export type AuthEnvironmentName = "development" | "production";

export interface StoredUser {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly studioName?: string;
  readonly studioNameSuffix?: string;
  readonly status: "active" | "suspended";
}

export interface StoredIdentity {
  readonly id: string;
  readonly userId: string;
  readonly kind: AuthChannelName;
  readonly lookupDigest: string;
  readonly ciphertext: string;
  readonly lookupKeyVersion: number;
  readonly verificationMode: VerificationMode;
  readonly environment: AuthEnvironmentName;
  readonly version: number;
  readonly verifiedAt: string;
}

export interface StoredChallenge {
  readonly id: string;
  readonly channel: AuthChannelName;
  readonly purpose: AuthPurposeName;
  readonly targetDigest: string;
  readonly ciphertext: string;
  readonly verifier: string | null;
  readonly strategy: "application_otp" | "provider_generated";
  readonly providerMode: VerificationMode;
  readonly environment: AuthEnvironmentName;
  readonly userId: string | null;
  readonly sessionHash: string | null;
  readonly continuationHash: string;
  readonly expectedVersion: number | null;
  readonly identityId?: string | null;
  readonly credentialVersion?: number | null;
  readonly reauthHash: string | null;
  readonly providerCorrelation: string | null;
  readonly expiresAt: string;
  readonly attempts: number;
  readonly resendAvailableAt: string;
  readonly supersededAt: string | null;
  readonly completedAt: string | null;
  readonly invalidatedAt: string | null;
  readonly deliveryState: "pending" | "accepted" | "failed" | "unknown";
  readonly idempotencyHash: string;
  readonly createdAt: string;
}

export interface StoredHandoff {
  readonly id: string;
  readonly tokenHash: string;
  readonly purpose: "register_confirm" | "reauth" | "password_reset";
  readonly channel: AuthChannelName;
  readonly targetDigest: string;
  readonly ciphertext: string;
  readonly providerMode: VerificationMode;
  readonly environment: AuthEnvironmentName;
  readonly userId: string | null;
  readonly sessionHash: string | null;
  readonly expectedVersion: number | null;
  readonly identityId?: string | null;
  readonly credentialVersion?: number | null;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

export interface StoredReceipt {
  readonly keyHash: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly sessionTokenHash: string;
  readonly purpose: string;
  /** First session in this receipt lineage. Lost-response reissue does not change it. */
  readonly originSessionId: string;
  /** Set by explicit logout. A closed receipt must not mint another session. */
  readonly closedAt: string | null;
  readonly payloadHash?: string | null;
  readonly credentialVersion?: number | null;
}

export interface StoredPasswordCredential {
  readonly userId: string;
  readonly verifier: string;
  readonly version: number;
  readonly updatedAt: string;
}
export interface StoredPasswordResetReceipt {
  readonly keyHash: string;
  readonly userId: string;
  readonly payloadHash: string;
  readonly credentialVersion: number;
  readonly closedAt: string | null;
}

export interface LockedAuthSession {
  readonly id: string;
  readonly tokenHash: string;
  readonly userId: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface StoredSession {
  readonly id: string;
  readonly tokenHash: string;
  readonly userId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly issuer: "verified_login";
  readonly authEnvironment: AuthEnvironmentName;
  readonly authChannel: AuthChannelName;
}

/** Persistence for one authentication transaction. Business rules stay in the service. */
export interface AuthUnitOfWork {
  findUser(id: string): Promise<StoredUser | null>;
  findIdentity(
    kind: AuthChannelName,
    digest: string,
  ): Promise<StoredIdentity | null>;
  listIdentities(userId: string): Promise<readonly StoredIdentity[]>;
  insertUser(user: StoredUser): Promise<"ok" | "handle_conflict">;
  insertIdentity(row: StoredIdentity): Promise<"ok" | "conflict">;
  replaceIdentity(
    row: StoredIdentity,
    expectedVersion: number,
  ): Promise<"ok" | "stale" | "conflict">;
  deleteIdentity(
    userId: string,
    kind: AuthChannelName,
    expectedVersion: number,
  ): Promise<"ok" | "stale" | "missing" | "last_factor">;
  lockUser(userId: string): Promise<StoredUser | null>;
  lockDigest(digest: string): Promise<void>;
  insertChallenge(row: StoredChallenge): Promise<"ok" | "conflict">;
  findChallenge(id: string): Promise<StoredChallenge | null>;
  findChallengeByIdempotency(hash: string): Promise<StoredChallenge | null>;
  saveChallenge(row: StoredChallenge): Promise<void>;
  openChallenge(filter: {
    readonly targetDigest: string;
    readonly purpose: AuthPurposeName;
    readonly channel: AuthChannelName;
  }): Promise<StoredChallenge | null>;
  failureCount(
    digest: string,
    purpose: string,
    sinceIso: string,
  ): Promise<number>;
  addFailure(digest: string, purpose: string, atIso: string): Promise<number>;
  sendCount(scope: string, key: string, sinceIso: string): Promise<number>;
  addSend(scope: string, key: string, atIso: string): Promise<void>;
  insertHandoff(row: StoredHandoff): Promise<void>;
  findHandoff(tokenHash: string): Promise<StoredHandoff | null>;
  consumeHandoff(
    id: string,
    atIso: string,
  ): Promise<"ok" | "consumed" | "missing">;
  insertReceipt(row: StoredReceipt): Promise<"ok" | "conflict">;
  findReceipt(keyHash: string): Promise<StoredReceipt | null>;
  lockSession(
    tokenHash: string,
    requiredEnvironment?: AuthEnvironmentName,
  ): Promise<LockedAuthSession | null>;
  lockReceipt(keyHash: string): Promise<StoredReceipt | null>;
  lockReceiptsForSession(sessionId: string): Promise<readonly StoredReceipt[]>;
  closeReceipt(keyHash: string, atIso: string): Promise<void>;
  updateReceiptSession(
    keyHash: string,
    sessionId: string,
    sessionTokenHash: string,
  ): Promise<void>;
  insertSession(row: StoredSession): Promise<void>;
  revokeSession(tokenHash: string, atIso: string): Promise<boolean>;
  revokeOtherSessions(
    userId: string,
    exceptTokenHash: string,
    atIso: string,
  ): Promise<void>;
  invalidateUserProofs(userId: string, atIso: string): Promise<void>;
  invalidatePasswordResetProofs(userId: string, atIso: string): Promise<void>;
  insertAudit(row: {
    readonly id: string;
    readonly userId: string | null;
    readonly action: string;
    readonly atIso: string;
  }): Promise<void>;
  findSessionUser(
    tokenHash: string,
    atIso: string,
    requiredEnvironment?: AuthEnvironmentName,
  ): Promise<StoredUser | null>;
  hasOpenFactorChange(
    userId: string,
    channel: AuthChannelName,
  ): Promise<boolean>;
  countUsers(): Promise<number>;
  findPasswordCredential(
    userId: string,
  ): Promise<StoredPasswordCredential | null>;
  savePasswordCredential(
    row: StoredPasswordCredential,
    expectedVersion: number | null,
  ): Promise<"ok" | "stale">;
  findPasswordResetReceipt(
    keyHash: string,
  ): Promise<StoredPasswordResetReceipt | null>;
  insertPasswordResetReceipt(
    row: StoredPasswordResetReceipt,
  ): Promise<"ok" | "conflict">;
  revokeAllSessions(userId: string, atIso: string): Promise<void>;
  closeUserReceipts(userId: string, atIso: string): Promise<void>;
}

export interface CommunityAuthPort {
  transaction<T>(work: (tx: AuthUnitOfWork) => Promise<T>): Promise<T>;
}
