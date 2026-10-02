import type {
  AuthChannelName,
  AuthPurposeName,
  AuthUnitOfWork,
  CommunityAuthPort,
  StoredChallenge,
  StoredHandoff,
  StoredIdentity,
  StoredReceipt,
  StoredSession,
  StoredUser,
  StoredPasswordCredential,
  StoredPasswordResetReceipt,
} from "./auth-port.js";

interface MemorySession extends StoredSession {
  revokedAt: string | null;
}

interface MemoryState {
  users: StoredUser[];
  credentials: StoredPasswordCredential[];
  passwordResetReceipts: StoredPasswordResetReceipt[];
  identities: StoredIdentity[];
  challenges: StoredChallenge[];
  handoffs: StoredHandoff[];
  receipts: StoredReceipt[];
  sessions: MemorySession[];
  sends: { scope: string; key: string; at: string }[];
  failures: { digest: string; purpose: string; at: string }[];
  audits: {
    id: string;
    userId: string | null;
    action: string;
    atIso: string;
  }[];
}

const emptyState = (): MemoryState => ({
  users: [],
  credentials: [],
  passwordResetReceipts: [],
  identities: [],
  challenges: [],
  handoffs: [],
  receipts: [],
  sessions: [],
  sends: [],
  failures: [],
  audits: [],
});

const after = (left: string, right: string): boolean =>
  new Date(left).getTime() > new Date(right).getTime();

const clone = (state: MemoryState): MemoryState => structuredClone(state);

/** In-memory port. Transactions are serialized and roll back on throw. */
export class MemoryCommunityAuthPort implements CommunityAuthPort {
  private state: MemoryState = emptyState();
  private queue: Promise<void> = Promise.resolve();

  /** Test seam for suspension races. Not part of the application port. */
  setStatus(userId: string, status: "active" | "suspended"): void {
    const index = this.state.users.findIndex((user) => user.id === userId);
    const current = this.state.users[index];
    if (current !== undefined) this.state.users[index] = { ...current, status };
  }

  async transaction<T>(work: (tx: AuthUnitOfWork) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const snapshot = clone(this.state);
      try {
        return await work(this.unit());
      } catch (error) {
        this.state = snapshot;
        throw error;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private unit(): AuthUnitOfWork {
    const state = this.state;
    return {
      findUser: async (id) =>
        state.users.find((user) => user.id === id) ?? null,
      findIdentity: async (kind, digest) =>
        state.identities.find(
          (row) => row.kind === kind && row.lookupDigest === digest,
        ) ?? null,
      listIdentities: async (userId) =>
        state.identities.filter((row) => row.userId === userId),
      insertUser: async (user) => {
        if (state.users.some((row) => row.handle === user.handle))
          return "handle_conflict";
        if (state.users.some((row) => row.id === user.id))
          return "handle_conflict";
        state.users.push(user);
        return "ok";
      },
      insertIdentity: async (row) => {
        if (
          state.identities.some(
            (item) =>
              (item.kind === row.kind &&
                item.lookupDigest === row.lookupDigest) ||
              (item.userId === row.userId && item.kind === row.kind),
          )
        )
          return "conflict";
        const versions = new Set(
          state.identities.map((item) => item.lookupKeyVersion),
        );
        if (versions.size > 0 && !versions.has(row.lookupKeyVersion))
          return "conflict";
        state.identities.push(row);
        return "ok";
      },
      replaceIdentity: async (row, expectedVersion) => {
        const index = state.identities.findIndex(
          (item) => item.userId === row.userId && item.kind === row.kind,
        );
        const current = state.identities[index];
        if (current === undefined || current.version !== expectedVersion)
          return "stale";
        if (
          state.identities.some(
            (item) =>
              item.id !== current.id &&
              item.kind === row.kind &&
              item.lookupDigest === row.lookupDigest,
          )
        )
          return "conflict";
        state.identities[index] = { ...row, version: expectedVersion + 1 };
        return "ok";
      },
      deleteIdentity: async (userId, kind, expectedVersion) => {
        const current = state.identities.find(
          (item) => item.userId === userId && item.kind === kind,
        );
        if (current === undefined) return "missing";
        if (current.version !== expectedVersion) return "stale";
        if (
          state.identities.filter((item) => item.userId === userId).length <= 1
        )
          return "last_factor";
        state.identities = state.identities.filter(
          (item) => item.id !== current.id,
        );
        return "ok";
      },
      lockUser: async (userId) =>
        state.users.find((user) => user.id === userId) ?? null,
      lockDigest: async () => undefined,
      insertChallenge: async (row) => {
        if (
          state.challenges.some(
            (item) => item.idempotencyHash === row.idempotencyHash,
          )
        )
          return "conflict";
        state.challenges.push(row);
        return "ok";
      },
      findChallenge: async (id) =>
        state.challenges.find((row) => row.id === id) ?? null,
      findChallengeByIdempotency: async (hash) =>
        state.challenges.find((row) => row.idempotencyHash === hash) ?? null,
      saveChallenge: async (row) => {
        const index = state.challenges.findIndex((item) => item.id === row.id);
        const current = state.challenges[index];
        if (current)
          state.challenges[index] = {
            ...row,
            supersededAt: current.supersededAt ?? row.supersededAt,
            completedAt: current.completedAt ?? row.completedAt,
            invalidatedAt: current.invalidatedAt ?? row.invalidatedAt,
          };
      },
      openChallenge: async (filter) =>
        state.challenges
          .filter(
            (row) =>
              row.channel === filter.channel &&
              row.purpose === filter.purpose &&
              row.targetDigest === filter.targetDigest &&
              row.supersededAt === null &&
              row.completedAt === null &&
              row.invalidatedAt === null &&
              (row.deliveryState === "pending" ||
                row.deliveryState === "accepted"),
          )
          .sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt),
          )[0] ?? null,
      failureCount: async (digest, purpose, sinceIso) =>
        state.failures.filter(
          (row) =>
            row.digest === digest &&
            row.purpose === purpose &&
            !after(sinceIso, row.at),
        ).length,
      addFailure: async (digest, purpose, atIso) => {
        state.failures.push({ digest, purpose, at: atIso });
        return state.failures.filter(
          (row) => row.digest === digest && row.purpose === purpose,
        ).length;
      },
      sendCount: async (scope, key, sinceIso) =>
        state.sends.filter(
          (row) =>
            row.scope === scope && row.key === key && !after(sinceIso, row.at),
        ).length,
      addSend: async (scope, key, atIso) => {
        state.sends.push({ scope, key, at: atIso });
      },
      insertHandoff: async (row) => {
        state.handoffs.push(row);
      },
      findHandoff: async (tokenHash) =>
        state.handoffs.find((row) => row.tokenHash === tokenHash) ?? null,
      consumeHandoff: async (id, atIso) => {
        const row = state.handoffs.find((item) => item.id === id);
        if (row === undefined) return "missing";
        if (row.consumedAt !== null) return "consumed";
        const index = state.handoffs.findIndex((item) => item.id === id);
        state.handoffs[index] = { ...row, consumedAt: atIso };
        return "ok";
      },
      insertReceipt: async (row) => {
        if (state.receipts.some((item) => item.keyHash === row.keyHash))
          return "conflict";
        state.receipts.push(row);
        return "ok";
      },
      findReceipt: async (keyHash) =>
        state.receipts.find((row) => row.keyHash === keyHash) ?? null,
      lockSession: async (tokenHash, requiredEnvironment) => {
        const row = state.sessions.find(
          (item) =>
            item.tokenHash === tokenHash &&
            (requiredEnvironment === undefined ||
              (item.issuer === "verified_login" &&
                item.authEnvironment === requiredEnvironment)),
        );
        if (row === undefined) return null;
        return {
          id: row.id,
          tokenHash: row.tokenHash,
          userId: row.userId,
          expiresAt: row.expiresAt,
          revokedAt: row.revokedAt,
        };
      },
      lockReceipt: async (keyHash) =>
        state.receipts.find((row) => row.keyHash === keyHash) ?? null,
      lockReceiptsForSession: async (sessionId) =>
        state.receipts.filter(
          (row) =>
            row.originSessionId === sessionId || row.sessionId === sessionId,
        ),
      closeReceipt: async (keyHash, atIso) => {
        const index = state.receipts.findIndex(
          (row) => row.keyHash === keyHash,
        );
        const current = state.receipts[index];
        if (current !== undefined && current.closedAt === null)
          state.receipts[index] = { ...current, closedAt: atIso };
      },
      updateReceiptSession: async (keyHash, sessionId, sessionTokenHash) => {
        const index = state.receipts.findIndex(
          (row) => row.keyHash === keyHash,
        );
        const current = state.receipts[index];
        if (current !== undefined)
          state.receipts[index] = { ...current, sessionId, sessionTokenHash };
      },
      insertSession: async (row) => {
        state.sessions.push({ ...row, revokedAt: null });
      },
      revokeSession: async (tokenHash, atIso) => {
        const index = state.sessions.findIndex(
          (row) =>
            row.tokenHash === tokenHash &&
            row.revokedAt === null &&
            after(row.expiresAt, atIso),
        );
        const current = state.sessions[index];
        if (current === undefined) return false;
        state.sessions[index] = { ...current, revokedAt: atIso };
        return true;
      },
      revokeOtherSessions: async (userId, exceptTokenHash, atIso) => {
        state.sessions = state.sessions.map((row) =>
          row.userId === userId &&
          row.tokenHash !== exceptTokenHash &&
          row.revokedAt === null
            ? { ...row, revokedAt: atIso }
            : row,
        );
      },
      invalidateUserProofs: async (userId, atIso) => {
        state.challenges = state.challenges.map((row) =>
          row.userId === userId &&
          row.completedAt === null &&
          row.invalidatedAt === null
            ? { ...row, invalidatedAt: atIso }
            : row,
        );
        state.handoffs = state.handoffs.map((row) =>
          row.userId === userId && row.consumedAt === null
            ? { ...row, consumedAt: atIso }
            : row,
        );
      },
      invalidatePasswordResetProofs: async (id, at) => {
        const digests = new Set(
          state.identities
            .filter((row) => row.userId === id)
            .map((row) => row.lookupDigest),
        );
        state.challenges = state.challenges.map((row) =>
          (row.userId === id || digests.has(row.targetDigest)) &&
          row.completedAt === null &&
          row.invalidatedAt === null
            ? { ...row, invalidatedAt: at }
            : row,
        );
        state.handoffs = state.handoffs.map((row) =>
          (row.userId === id || digests.has(row.targetDigest)) &&
          row.consumedAt === null
            ? { ...row, consumedAt: at }
            : row,
        );
      },
      insertAudit: async (row) => {
        state.audits.push(row);
      },
      hasOpenFactorChange: async (userId, channel) =>
        state.challenges.some(
          (row) =>
            row.userId === userId &&
            row.channel === channel &&
            (row.purpose === "link" || row.purpose === "replace") &&
            row.supersededAt === null &&
            row.completedAt === null &&
            row.invalidatedAt === null &&
            (row.deliveryState === "pending" ||
              row.deliveryState === "accepted"),
        ),
      findSessionUser: async (tokenHash, atIso, requiredEnvironment) => {
        const session = state.sessions.find(
          (row) =>
            row.tokenHash === tokenHash &&
            (requiredEnvironment === undefined ||
              (row.issuer === "verified_login" &&
                row.authEnvironment === requiredEnvironment)) &&
            row.revokedAt === null &&
            after(row.expiresAt, atIso),
        );
        if (session === undefined) return null;
        return state.users.find((user) => user.id === session.userId) ?? null;
      },
      countUsers: async () => state.users.length,
      findPasswordCredential: async (id) =>
        state.credentials.find((row) => row.userId === id) ?? null,
      savePasswordCredential: async (row, expected) => {
        const index = state.credentials.findIndex(
          (current) => current.userId === row.userId,
        );
        const current = state.credentials[index];
        if ((current?.version ?? null) !== expected) return "stale";
        if (current) state.credentials[index] = row;
        else state.credentials.push(row);
        return "ok";
      },
      findPasswordResetReceipt: async (key) =>
        state.passwordResetReceipts.find((row) => row.keyHash === key) ?? null,
      insertPasswordResetReceipt: async (row) => {
        if (
          state.passwordResetReceipts.some((old) => old.keyHash === row.keyHash)
        )
          return "conflict";
        state.passwordResetReceipts.push(row);
        return "ok";
      },
      revokeAllSessions: async (id, at) => {
        state.sessions = state.sessions.map((row) =>
          row.userId === id && row.revokedAt === null
            ? { ...row, revokedAt: at }
            : row,
        );
      },
      closeUserReceipts: async (id, at) => {
        state.receipts = state.receipts.map((row) =>
          row.userId === id && row.closedAt === null
            ? { ...row, closedAt: at }
            : row,
        );
        state.passwordResetReceipts = state.passwordResetReceipts.map((row) =>
          row.userId === id && row.closedAt === null
            ? { ...row, closedAt: at }
            : row,
        );
      },
    };
  }
}

export const createMemoryCommunityAuthPort = (): MemoryCommunityAuthPort =>
  new MemoryCommunityAuthPort();

export type { AuthChannelName, AuthPurposeName };
