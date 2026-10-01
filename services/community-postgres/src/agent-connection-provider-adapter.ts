import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

import type { Pool } from "pg";

/**
 * Agent Connections V1 (Issue #141 r13): the `oidc-provider@9.12.2` adapter.
 *
 * Written against the contract the provider was OBSERVED to use, not against
 * documentation and not against the throwaway adapter an earlier round wrote,
 * which failed the contract while reporting a hit. The facts that shape this:
 *
 *  - Exactly six models are ever constructed under the configured feature set:
 *    Session, Interaction, AuthorizationCode, AccessToken, RefreshToken, Grant.
 *    One instance per model, cached for the provider's lifetime.
 *  - `upsert(id, payload, expiresIn)` always arrives with three arguments, and
 *    it is a genuine UPSERT: an Interaction is written twice under one id.
 *  - `payload.jti` always equals the `id` argument.
 *  - For five of the six models the id IS the credential — the interaction
 *    cookie, the authorization code, the session cookie, the access token and
 *    the refresh token are each exactly their own row key. So ids are stored
 *    as keyed digests and payloads as authenticated ciphertext.
 *  - `find` receives one argument. The provider DOES ask for expired rows --
 *    `refresh_token.js` calls `RefreshToken.find(value, {ignoreExpiration:
 *    true})` -- but that option never reaches ANY adapter: `base_model.js:119`
 *    calls `this.adapter.find(value)` with one argument and applies the option
 *    itself at `:125`, in `verify`. The reference `MemoryAdapter.find(id)` is
 *    one-parameter too. An earlier version of this file read the missing
 *    option as permission to filter expiry here. That was backwards: the
 *    reference adapter does not filter at all, because the model checks expiry
 *    under `clockTolerance` (default 15s) before the adapter is ever consulted
 *    about it.
 *
 *    Two corrections to the record, both made after being checked against the
 *    provider rather than argued. First, filtering here was never a security
 *    hole: `refresh_token.js` throws `InvalidGrant('refresh token is
 *    expired')` at its `isExpired` check BEFORE it reaches the `consumed`
 *    check that revokes the grant family, so an expired replay is refused
 *    either way, and an UNexpired consumed token was never hidden by the
 *    filter. That ordering is read directly from the provider source; the
 *    end-to-end confirmation -- replaying a consumed refresh token with a past
 *    `exp` yields `invalid_grant` and leaves the grant count unchanged -- was
 *    the independent reviewer's measurement, not ours.
 *    Second, what filtering actually cost is smaller and real --
 *    the 15-second clock tolerance the provider is entitled to apply, and the
 *    difference between "expired" and "not found" in the error the client
 *    sees. The filter is gone because the contract says so, not because
 *    keeping it was dangerous.
 *  - `revokeByGrantId` is called on AuthorizationCode, AccessToken and
 *    RefreshToken — never on Grant. Grant destruction arrives as
 *    `Grant.adapter.destroy(grantId)`, directly on the adapter.
 *  - Session `destroy` must tolerate an id that is already gone: session
 *    rotation destroys the old id before saving the new one.
 *  - `findByUserCode` is never called under this configuration; it is the one
 *    method that may be a stub, and it throws rather than pretending.
 */

/** The allowlist. A new provider feature is a migration, not a new row type. */
const MODELS = [
  "Session",
  "Interaction",
  "AuthorizationCode",
  "AccessToken",
  "RefreshToken",
  "Grant",
] as const;
export type ProviderModel = (typeof MODELS)[number];

/**
 * Models this provider KNOWS about and deliberately does not store.
 *
 * `Client` is the one that matters. Dynamic client registration is off by
 * design — every client is preregistered in one setting read by both sides —
 * so there is no dynamically-registered client to find, ever. But
 * `oidc-provider` still constructs `new Adapter("Client")` while resolving an
 * unknown `client_id`, and this adapter used to THROW there, which surfaced
 * as `server_error: oops! something went wrong` with a 500.
 *
 * Measured against the running provider: a mistyped or unregistered client id
 * — the single most likely setup mistake an Owner or a client author will
 * make — produced an opaque server error instead of `invalid_client`. It
 * failed closed, so it was never a way in; it was a way to be unable to tell
 * what was wrong.
 *
 * So this is NOT a hole in the allowlist. An unknown model still throws,
 * because an unexpected model still means a provider feature was enabled
 * without the migration that bounds its storage. This says something
 * different and narrower: we know what a Client is, we store none, a lookup
 * finds nothing, and every write is refused.
 */
const UNSTORED_MODELS = ["Client"] as const;
export type UnstoredProviderModel = (typeof UNSTORED_MODELS)[number];

const FORMAT_VERSION = 1;

export class ProviderAdapterKeyError extends Error {
  override readonly name = "ProviderAdapterKeyError";
}

export interface ProviderAdapterKeys {
  /** Keys ids for lookup. Server-held; never derived from the id itself. */
  readonly indexKey: Buffer;
  /** Seals payloads. Server-held, versioned, outside the repository. */
  readonly sealKey: Buffer;
}

/**
 * Reads the keys from the environment. They are deliberately NOT defaulted:
 * an adapter that silently invents a key would encrypt everything under a
 * value an attacker also knows, which is worse than refusing to start.
 */
export const providerAdapterKeysFrom = (
  environment: NodeJS.ProcessEnv,
): ProviderAdapterKeys => {
  const read = (name: string): Buffer => {
    const raw = environment[name];
    if (raw === undefined || raw === "")
      throw new ProviderAdapterKeyError(`${name} is required`);
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32)
      throw new ProviderAdapterKeyError(`${name} must be 32 bytes, base64`);
    return key;
  };
  return {
    indexKey: read("AGENT_CONNECTION_PROVIDER_INDEX_KEY"),
    sealKey: read("AGENT_CONNECTION_PROVIDER_SEAL_KEY"),
  };
};

/** Domain-separated so a digest from one model cannot match another's row. */
const digestOf = (keys: ProviderAdapterKeys, model: string, value: string) =>
  createHmac("sha256", keys.indexKey)
    .update(`artvenn-agent-connection-provider-v1|${model}|${value}`)
    .digest("hex");

/**
 * The AAD binds a payload to the row it lives in. It uses the LOOKUP DIGEST
 * rather than the raw id: the digest is derived from (model, id) so it carries
 * the same anti-relocation property, and unlike the id it is available on BOTH
 * lookup paths. `find` knows the id; `findByUid` does not, and binding to the
 * id would leave a uid lookup unable to open its own row.
 */
const aadFor = (model: string, lookupDigest: string): Buffer =>
  Buffer.from(`${FORMAT_VERSION}|${model}|${lookupDigest}`);

const seal = (
  keys: ProviderAdapterKeys,
  model: string,
  lookupDigest: string,
  payload: unknown,
): Buffer => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.sealKey, nonce);
  cipher.setAAD(aadFor(model, lookupDigest));
  const body = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]);
};

const open = (
  keys: ProviderAdapterKeys,
  model: string,
  lookupDigest: string,
  sealed: Buffer,
): unknown => {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keys.sealKey,
    sealed.subarray(0, 12),
  );
  decipher.setAAD(aadFor(model, lookupDigest));
  decipher.setAuthTag(sealed.subarray(12, 28));
  const plaintext = Buffer.concat([
    decipher.update(sealed.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as unknown;
};

/**
 * A corrupt or tampered row is a MISS, not a throw: failing closed is what
 * keeps an altered row from being treated as authority.
 */
const unseal = (
  keys: ProviderAdapterKeys,
  model: string,
  lookupDigest: string,
  sealed: Buffer,
  consumedAt: Date | null,
  storedGrantId: string | null,
  onUnsealFailure?: (
    model: string,
    lookupDigest: string,
    reason: string,
  ) => void,
): Record<string, unknown> | undefined => {
  let payload: Record<string, unknown>;
  try {
    payload = open(keys, model, lookupDigest, sealed) as Record<
      string,
      unknown
    >;
  } catch {
    // Still a miss rather than a throw, but no longer SILENT: a tampered row,
    // a partial write and a key rotation otherwise all look exactly like an
    // ordinary expiry, and users appear randomly logged out with no signal
    // that it is an integrity problem.
    onUnsealFailure?.(model, lookupDigest, "unseal-failed");
    return undefined;
  }
  // `grant_id` is stored in plaintext so `revokeByGrantId` can sweep without
  // opening anything -- which means it is OUTSIDE the authenticated payload
  // and can be edited to point a row away from its own grant. The sealed
  // payload is the authority; a disagreement is a tampered row.
  const sealedGrantId =
    typeof payload.grantId === "string" ? payload.grantId : null;
  if (sealedGrantId !== storedGrantId) {
    onUnsealFailure?.(model, lookupDigest, "grant-id-mismatch");
    return undefined;
  }
  // The provider reads `consumed` back to tell a replay from a miss.
  return consumedAt === null
    ? payload
    : { ...payload, consumed: Math.floor(consumedAt.getTime() / 1000) };
};

const TABLE = "community.agent_connection_provider_artifacts";

export interface ProviderAdapterOptions {
  /** Separate public-authoring protocol store; never inferred from a token. */
  readonly namespace?: "admin" | "article-authoring";
  readonly pool: Pick<Pool, "query">;
  readonly keys: ProviderAdapterKeys;
  readonly now?: () => Date;
  /**
   * Called when a row cannot be opened or disagrees with its own payload.
   * Receives no credential: the model, the row's digest and a bare reason.
   */
  readonly onUnsealFailure?: (
    model: string,
    lookupDigest: string,
    reason: string,
  ) => void;
}

/**
 * Builds the adapter class the provider constructs as `new Adapter(name)`.
 * The provider caches one instance per model, so per-instance state is safe.
 */
export const createProviderAdapter = (options: ProviderAdapterOptions) => {
  const { pool, keys } = options;
  const table =
    options.namespace === "article-authoring"
      ? "community.article_authoring_provider_artifacts"
      : TABLE;
  const now = options.now ?? (() => new Date());

  return class ProviderArtifactAdapter {
    /** Readonly rather than private: the class is returned from a factory, and
     * TypeScript cannot emit a declaration for a private member of an
     * anonymous exported class. */
    readonly model: ProviderModel;

    /** True for a model we know and deliberately keep no rows for. */
    readonly unstored: boolean;

    constructor(name: string) {
      if ((UNSTORED_MODELS as readonly string[]).includes(name)) {
        this.unstored = true;
        // Never read or written; the branches below return before using it.
        this.model = "Session";
        return;
      }
      if (!(MODELS as readonly string[]).includes(name))
        // Refusing is the point: an unexpected model means a provider feature
        // was enabled without the migration that bounds its storage.
        throw new Error(`unsupported provider model ${name}`);
      this.unstored = false;
      this.model = name as ProviderModel;
    }

    async upsert(
      id: string,
      payload: Record<string, unknown>,
      expiresIn: number,
    ): Promise<void> {
      // A write for a model we deliberately store none of is a REFUSAL, not a
      // quiet no-op: reaching here would mean dynamic client registration had
      // been switched on somewhere, and this adapter must not be the thing
      // that silently makes that work.
      if (this.unstored)
        throw new Error(`refusing to store provider model ${"Client"}`);
      const expiresAt = new Date(now().getTime() + expiresIn * 1000);
      const uid = typeof payload.uid === "string" ? payload.uid : undefined;
      await pool.query(
        `INSERT INTO ${table}
           (lookup_digest, model, sealed_payload, format_version, grant_id,
            uid_digest, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (lookup_digest) DO UPDATE SET
           sealed_payload = EXCLUDED.sealed_payload,
           format_version = EXCLUDED.format_version,
           grant_id = EXCLUDED.grant_id,
           uid_digest = EXCLUDED.uid_digest,
           expires_at = EXCLUDED.expires_at`,
        [
          digestOf(keys, this.model, id),
          this.model,
          seal(keys, this.model, digestOf(keys, this.model, id), payload),
          FORMAT_VERSION,
          typeof payload.grantId === "string" ? payload.grantId : null,
          uid === undefined || this.model !== "Session"
            ? null
            : digestOf(keys, "Session:uid", uid),
          expiresAt,
        ],
      );
    }

    /**
     * Expiry is NOT filtered here. The provider owns that decision, applies
     * its own `clockTolerance`, and deliberately reads past-`exp` rows on the
     * reuse-detection path. Rows are reaped by `deleteExpired`, not hidden.
     *
     * A corrupt, unopenable or self-inconsistent row is a miss, not a throw:
     * failing closed is what keeps a tampered row from becoming authority.
     */
    async find(id: string): Promise<Record<string, unknown> | undefined> {
      // No Client is ever stored: a lookup finds nothing, and the provider
      // answers `invalid_client` instead of a server error.
      if (this.unstored) return undefined;
      const digest = digestOf(keys, this.model, id);
      const { rows } = await pool.query(
        `SELECT sealed_payload, consumed_at, grant_id FROM ${table}
          WHERE lookup_digest=$1 AND model=$2`,
        [digest, this.model],
      );
      const row = rows[0] as
        | {
            sealed_payload: Buffer;
            consumed_at: Date | null;
            grant_id: string | null;
          }
        | undefined;
      if (row === undefined) return undefined;
      return unseal(
        keys,
        this.model,
        digest,
        row.sealed_payload,
        row.consumed_at,
        row.grant_id,
        options.onUnsealFailure,
      );
    }

    /** Session only. The uid is a second identifier the provider looks up by. */
    async findByUid(uid: string): Promise<Record<string, unknown> | undefined> {
      // No Client is ever stored: a lookup finds nothing, and the provider
      // answers `invalid_client` instead of a server error.
      if (this.unstored) return undefined;
      const { rows } = await pool.query(
        `SELECT lookup_digest, sealed_payload, consumed_at, grant_id
           FROM ${table} WHERE uid_digest=$1 AND model='Session'`,
        [digestOf(keys, "Session:uid", uid)],
      );
      const row = rows[0] as
        | {
            lookup_digest: string;
            sealed_payload: Buffer;
            consumed_at: Date | null;
            grant_id: string | null;
          }
        | undefined;
      if (row === undefined) return undefined;
      return unseal(
        keys,
        this.model,
        row.lookup_digest,
        row.sealed_payload,
        row.consumed_at,
        row.grant_id,
        options.onUnsealFailure,
      );
    }

    /** Atomic: the row is marked consumed in one statement, never read-modify-write. */
    async consume(id: string): Promise<void> {
      if (this.unstored) return;
      await pool.query(
        `UPDATE ${table} SET consumed_at=$3
          WHERE lookup_digest=$1 AND model=$2 AND consumed_at IS NULL`,
        [digestOf(keys, this.model, id), this.model, now()],
      );
    }

    /** Tolerates an id that is already gone: session rotation destroys first. */
    async destroy(id: string): Promise<void> {
      if (this.unstored) return;
      await pool.query(
        `DELETE FROM ${table} WHERE lookup_digest=$1 AND model=$2`,
        [digestOf(keys, this.model, id), this.model],
      );
    }

    /**
     * Called on AuthorizationCode, AccessToken and RefreshToken. Idempotent by
     * construction — a second sweep deletes nothing and creates no authority.
     */
    async revokeByGrantId(grantId: string): Promise<void> {
      if (this.unstored) return;
      await pool.query(`DELETE FROM ${table} WHERE grant_id=$1 AND model=$2`, [
        grantId,
        this.model,
      ]);
    }

    /**
     * Bounded reaping, which is what removes expired rows now that `find` no
     * longer hides them. Deletes nothing that is still live and creates no
     * authority.
     *
     * NOTHING CALLS THIS YET. There is no authorization service in this slice,
     * so no rows accumulate either -- but the moment one runs, expired
     * artifacts stay findable until something schedules this, once per model,
     * because the sweep is per-model by design.
     */
    async deleteExpired(limit = 1000): Promise<number> {
      const { rowCount } = await pool.query(
        `DELETE FROM ${table} WHERE lookup_digest IN (
           SELECT lookup_digest FROM ${table}
            WHERE model=$1 AND expires_at <= $2 LIMIT $3)`,
        [this.model, now(), limit],
      );
      return rowCount ?? 0;
    }

    /** Never called under this configuration. It refuses rather than pretending. */
    async findByUserCode(): Promise<never> {
      throw new Error(
        "findByUserCode is not supported: the device grant is not enabled",
      );
    }
  };
};
