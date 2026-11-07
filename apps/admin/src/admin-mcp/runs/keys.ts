import { createHash } from "node:crypto";

import type { AdminMcpKey } from "../door";

/**
 * The keys a run is found and replayed by (admin-mcp-completion-v1 sections 8 and 22).
 * Each is a durable format: a stored run outlives a release, so a change here is a new
 * version, never an edit, and the tests pin each by a fixed vector.
 */

/** A sha256 digest written as a uuid, so a Backend route takes it as a key too. */
export const uuidOfDigest = (hash: string) =>
  `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;

/** As mcp_runs checks it: a key by its row id, a connection by its own id. */
export const RUN_CREDENTIAL = /^(?:key:[1-9][0-9]*|conn:[A-Za-z0-9_-]{1,80})$/u;

/**
 * Who a run belongs to. requestId's scope and the rolling 24-hour figure are per
 * credential, never per `users` row, which every connection shares, nor per numeric
 * key, which a connection has none of (section 22).
 */
export interface RunCredential {
  readonly credential: string;
  readonly keyId?: number;
  readonly connectionId?: string;
}

export const runCredentialOf = ({
  id,
  connection,
}: Pick<AdminMcpKey, "id" | "connection">): RunCredential => {
  const found: RunCredential =
    connection !== undefined
      ? { credential: `conn:${connection.id}`, connectionId: connection.id }
      : typeof id === "number"
        ? { credential: `key:${id}`, keyId: id }
        : { credential: "" };
  if (!RUN_CREDENTIAL.test(found.credential))
    throw new Error("RUN_CREDENTIAL_INVALID");
  return found;
};

/**
 * One target's key under a run: its CMS receipt's idempotencyKey, and a community
 * write's requestId and x-operator-request-id. From the run and the index alone, so an
 * execute call under another requestId replays it, and in its own versioned domain, so
 * it never meets a key requestKeyFor derives.
 */
export const runTargetKey = (runId: string, index: number) =>
  uuidOfDigest(
    createHash("sha256")
      .update(JSON.stringify(["run-target/v1", runId, index]))
      .digest("hex"),
  );
