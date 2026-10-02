import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Agent Connections V1 (Issue #141 r14 §5) — the external token, and the
 * grant provenance that travels with it.
 *
 * r11 chose Design B and r12 proved it: `oidc-provider@9.12.2` cannot be made
 * to emit a prefixed access token, so ArtVenn mints its own opaque value and
 * keeps a mapping to the provider's own token. r13 built the table. This is
 * the code that writes and reads it.
 *
 * The single rule this file exists to make structural rather than
 * conventional:
 *
 *   **A wrapper's consent generation is read from the GRANT, never supplied by
 *   the caller and never read from the connection.**
 *
 * `mint` therefore takes a grant id and derives the connection and the
 * generation from the frozen grant row itself. A caller cannot pass the wrong
 * generation because a caller cannot pass one at all. That closes the r12
 * defect at the only place it could be reintroduced: a refresh is redeemed at
 * the provider, which knows nothing about ArtVenn's generation, so anything
 * that stamped "the current generation" at mint would hand a disconnected
 * client a token that looks freshly consented.
 *
 * The database is the second line of the same defence: the composite foreign
 * key `(grant_id, connection_id, generation)` references the grant's frozen
 * identity tuple, so a row that disagrees with its grant cannot be inserted
 * even if this code were wrong.
 */

/** Domain separation for the fixed-length comparison helper below. */
const FIXED_LENGTH_DOMAIN = Buffer.from(
  "artvenn-agent-connection-wrapper-compare-v1",
  "utf8",
);

/** The reserved namespace. Dispatch, never authentication. */
export const WRAPPER_PREFIX = "artvenn_ct_";

/** 256 bits of opacity. The value itself is never stored, in any form. */
const WRAPPER_ENTROPY_BYTES = 32;

/**
 * The sealed layout this version writes: nonce(12) || tag(16) || ciphertext.
 * Stored beside the row so a later layout is a deliberate migration rather
 * than a silent reinterpretation of old bytes.
 */
const FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class WrapperKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrapperKeyError";
  }
}

export interface WrapperKeys {
  readonly indexKey: Buffer;
  readonly sealKey: Buffer;
}

/**
 * Separate keys from the provider adapter's, on purpose. The two stores answer
 * different questions and a single key would make a compromise of either one a
 * compromise of both.
 */
export const wrapperKeysFrom = (
  environment: NodeJS.ProcessEnv,
): WrapperKeys => {
  const read = (name: string): Buffer => {
    const raw = environment[name];
    if (raw === undefined || raw === "")
      throw new WrapperKeyError(`${name} is required`);
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32)
      throw new WrapperKeyError(`${name} must be 32 bytes, base64`);
    return key;
  };
  return {
    indexKey: read("AGENT_CONNECTION_WRAPPER_INDEX_KEY"),
    sealKey: read("AGENT_CONNECTION_WRAPPER_SEAL_KEY"),
  };
};

/** Domain-separated, so no digest from another store can collide with one here. */
const lookupDigestOf = (keys: WrapperKeys, presented: string): string =>
  createHmac("sha256", keys.indexKey)
    .update(`artvenn-agent-connection-wrapper-v1|${presented}`)
    .digest("hex");

/**
 * The additional authenticated data. Binding the provenance INTO the seal
 * means a row whose plaintext provenance has been edited cannot be opened at
 * all — the tag check fails — rather than opening and quietly resolving to a
 * different grant.
 *
 * The grant id carries the rest of the consent transitively: the resource, the
 * subject, the client and the consented preset all live on the grant row, and
 * every one of them is frozen by trigger. Copying them into the AAD would add
 * bytes, not binding.
 *
 * `expires_at` is deliberately NOT in here, and that is a one-layer defence
 * rather than the two the provenance gets: only the freeze trigger holds it.
 * Adding it would mean the AAD could not be recomputed without also trusting
 * the column it is meant to protect, which is circular. Named rather than left
 * for someone to discover.
 */
const aadFor = (
  formatVersion: number,
  lookupDigest: string,
  grantId: string,
  connectionId: string,
  generation: number,
): Buffer =>
  Buffer.from(
    `${formatVersion}|${lookupDigest}|${grantId}|${connectionId}|${generation}`,
    "utf8",
  );

const seal = (keys: WrapperKeys, aad: Buffer, plaintext: string): Buffer => {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keys.sealKey, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]);
};

const open = (
  keys: WrapperKeys,
  aad: Buffer,
  sealed: Buffer,
): string | undefined => {
  if (sealed.length < NONCE_BYTES + TAG_BYTES + 1) return undefined;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keys.sealKey,
      sealed.subarray(0, NONCE_BYTES),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(sealed.subarray(NONCE_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // A tampered row, a rotated key, or a partial write. All three are a miss:
    // failing closed is what stops an unopenable row becoming authority.
    return undefined;
  }
};

/** What a presented wrapper resolves to. */
export interface ResolvedWrapper {
  /** The provider's own token identifier. The only secret in here. */
  readonly jti: string;
  readonly grantId: string;
  readonly connectionId: string;
  /** The consent generation, as frozen on the grant when this was minted. */
  readonly generation: number;
  readonly expiresAt: string;
  readonly invalidatedAt: string | null;
}

export interface MintedWrapper {
  /** The value the client receives. Returned once, stored nowhere. */
  readonly presented: string;
  readonly lookupDigest: string;
  readonly grantId: string;
  readonly connectionId: string;
  readonly generation: number;
}

/** A mint that cannot be anchored. Never a wrapper bound to nothing. */
export class WrapperGrantMissingError extends Error {
  readonly grantId: string;
  constructor(grantId: string) {
    super(`no consent grant to anchor a wrapper to: ${grantId}`);
    this.name = "WrapperGrantMissingError";
    this.grantId = grantId;
  }
}

type Queryable = {
  query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number | null }>;
};

export interface WrapperStoreOptions {
  /** Explicit domain; omitted keeps every existing Admin caller unchanged. */
  readonly namespace?: "admin" | "article-authoring";
  readonly pool: Queryable;
  readonly keys: WrapperKeys;
  /**
   * Server-side alarm. Receives a bare reason and the lookup digest, never the
   * presented value and never the jti. A row that will not open is an
   * integrity event, and without this it is indistinguishable from a client
   * simply presenting an unknown token.
   */
  readonly onResolveFailure?: (reason: string, lookupDigest: string) => void;
}

const TABLE = "community.agent_connection_wrappers";

export const createWrapperStore = (options: WrapperStoreOptions) => {
  const { pool, keys } = options;
  const authoring = options.namespace === "article-authoring";
  const table = authoring ? "community.article_authoring_wrappers" : TABLE;
  const grantTable = authoring
    ? "community.article_authoring_grants"
    : "community.agent_connection_grants";
  const grantGeneration = authoring ? "generation" : "generation_at_consent";
  const prefix = authoring ? "artvenn_article_ct_" : WRAPPER_PREFIX;

  const newPresented = () =>
    `${prefix}${randomBytes(WRAPPER_ENTROPY_BYTES).toString("base64url")}`;

  return {
    /**
     * Mints one external token for a provider token, anchored to the consent
     * the grant froze.
     *
     * There is no `generation` parameter and no `connectionId` parameter by
     * design: both are read from the grant row inside the same statement that
     * inserts the wrapper, so the binding is a property of the schema rather
     * than a promise about calling convention.
     */
    async mint(input: {
      readonly grantId: string;
      readonly jti: string;
      readonly expiresAt: Date;
    }): Promise<MintedWrapper> {
      const anchor = await pool.query(
        `SELECT connection_id, ${grantGeneration} AS generation_at_consent
           FROM ${grantTable} WHERE grant_id=$1`,
        [input.grantId],
      );
      const row = anchor.rows[0] as
        | { connection_id: string; generation_at_consent: string | number }
        | undefined;
      if (row === undefined) throw new WrapperGrantMissingError(input.grantId);
      const connectionId = row.connection_id;
      const generation = Number(row.generation_at_consent);
      if (!Number.isSafeInteger(generation))
        throw new WrapperGrantMissingError(input.grantId);

      const presented = newPresented();
      const lookupDigest = lookupDigestOf(keys, presented);
      const sealed = seal(
        keys,
        aadFor(
          FORMAT_VERSION,
          lookupDigest,
          input.grantId,
          connectionId,
          generation,
        ),
        input.jti,
      );

      await pool.query(
        `INSERT INTO ${table}
           (lookup_digest, sealed_jti, format_version, grant_id, connection_id,
            generation, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          lookupDigest,
          sealed,
          FORMAT_VERSION,
          input.grantId,
          connectionId,
          generation,
          input.expiresAt,
        ],
      );

      return {
        presented,
        lookupDigest,
        grantId: input.grantId,
        connectionId,
        generation,
      };
    },

    /**
     * Resolves a presented wrapper. Returns undefined for anything that is not
     * exactly one live, openable, self-consistent row — an unknown value, a
     * tampered row, a rotated key, a wrapper whose plaintext provenance
     * disagrees with what was sealed.
     *
     * Expiry is NOT filtered here, and invalidation is reported rather than
     * hidden. The boundary above decides what a past-expiry or invalidated
     * wrapper means; a store that quietly dropped them would make a revoked
     * token indistinguishable from a typo.
     */
    async resolve(presented: string): Promise<ResolvedWrapper | undefined> {
      if (!presented.startsWith(prefix)) return undefined;
      const lookupDigest = lookupDigestOf(keys, presented);
      const { rows } = await pool.query(
        `SELECT sealed_jti, format_version, grant_id, connection_id, generation,
                expires_at, invalidated_at
           FROM ${table} WHERE lookup_digest=$1`,
        [lookupDigest],
      );
      const row = rows[0] as
        | {
            sealed_jti: Buffer;
            format_version: number;
            grant_id: string;
            connection_id: string;
            generation: string | number;
            expires_at: Date;
            invalidated_at: Date | null;
          }
        | undefined;
      if (row === undefined) return undefined;

      const generation = Number(row.generation);
      if (!Number.isSafeInteger(generation)) {
        options.onResolveFailure?.("generation-unreadable", lookupDigest);
        return undefined;
      }
      // The stored format version selects the layout. Reading it from the row
      // rather than assuming the constant is what makes a future v2 a
      // migration instead of a silent misinterpretation of old bytes.
      if (row.format_version !== FORMAT_VERSION) {
        options.onResolveFailure?.("format-version-unsupported", lookupDigest);
        return undefined;
      }
      const jti = open(
        keys,
        aadFor(
          row.format_version,
          lookupDigest,
          row.grant_id,
          row.connection_id,
          generation,
        ),
        row.sealed_jti,
      );
      if (jti === undefined) {
        // Because the provenance is inside the AAD, this is also what an
        // edited grant_id, connection_id or generation looks like: the tag
        // check fails and the row simply will not open.
        options.onResolveFailure?.("unseal-failed", lookupDigest);
        return undefined;
      }
      return {
        jti,
        grantId: row.grant_id,
        connectionId: row.connection_id,
        generation,
        expiresAt: row.expires_at.toISOString(),
        invalidatedAt: row.invalidated_at?.toISOString() ?? null,
      };
    },

    /**
     * Invalidates every wrapper of one grant. `invalidated_at` is the single
     * column the freeze trigger leaves writable, and it is set once: an
     * already-invalidated wrapper keeps its original timestamp, so the record
     * of when access was withdrawn cannot be quietly moved.
     */
    async invalidateByGrant(grantId: string, at: Date): Promise<number> {
      const { rowCount } = await pool.query(
        `UPDATE ${table} SET invalidated_at=$2
          WHERE grant_id=$1 AND invalidated_at IS NULL`,
        [grantId, at],
      );
      return rowCount ?? 0;
    },

    /** Bounded reaping of wrappers whose own expiry has passed. */
    async deleteExpired(before: Date, limit = 1000): Promise<number> {
      const { rowCount } = await pool.query(
        `DELETE FROM ${table} WHERE lookup_digest IN (
           SELECT lookup_digest FROM ${table} WHERE expires_at <= $1 LIMIT $2)`,
        [before, limit],
      );
      return rowCount ?? 0;
    },

    /** Exposed for tests that must assert on the stored row without the value. */
    digestOf(presented: string): string {
      return lookupDigestOf(keys, presented);
    },
  };
};

export type WrapperStore = ReturnType<typeof createWrapperStore>;

/**
 * Constant-time comparison for any place a wrapper value is compared at all.
 * Nothing in this module needs it — lookup is by digest — but a caller that
 * compares two presented values must not do it with `===`.
 */
export const wrapperValuesEqual = (a: string, b: string): boolean => {
  // Hashing first makes the compared buffers a fixed length, so the early
  // length check that `timingSafeEqual` otherwise forces cannot leak how long
  // the presented value was. Cheap, and it removes the one asymmetry a
  // constant-time helper should not have.
  const left = createHmac("sha256", FIXED_LENGTH_DOMAIN).update(a).digest();
  const right = createHmac("sha256", FIXED_LENGTH_DOMAIN).update(b).digest();
  return timingSafeEqual(left, right);
};
