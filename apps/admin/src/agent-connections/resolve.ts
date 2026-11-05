import { randomBytes } from "node:crypto";

import { ConsentError } from "./consent";

import type { ConsentRuntime } from "./runtime";
import type { StoredConnection } from "@moya/community-postgres";

/**
 * Agent Connections V1 (Issue #141 r15 §5) — finding, or opening, the record a
 * consent will attach to.
 *
 * Its own module so the decision path never imports `payload`: the review page
 * and the committed regression both call it, and only one of them is inside a
 * framework.
 */

const newConnectionId = (): string => `conn-${randomBytes(16).toString("hex")}`;

/**
 * The machine principal label. Derived from the client family and a random
 * suffix, never supplied by a caller: a request that could name a principal
 * could name one that already exists and inherit its authority.
 */
const principalLabelFor = (family: string): string =>
  `agent-${family}-${randomBytes(6).toString("hex")}`;

/**
 * Finds the connection this human holds for this exact client, creating one
 * that grants nothing if there is none.
 *
 * A new connection is `awaiting-consent` at generation 0 — powerless until a
 * human says otherwise in a browser. Creating it here is not consent and does
 * not authorize anything; it is the record consent will later attach to.
 *
 * THE READ BELOW DOES NOT GUARD THE WRITE, and it is not trying to. This runs
 * during the consent review page's server render, and Next prefetches links, so
 * two renders of one navigation is an ordinary event rather than an exotic one:
 * both read "no connection" and both used to insert one. Measured on a
 * disposable target — two rows, same millisecond, matching the pair the Owner
 * walkthrough reported. What closes it is `createForClient`, where the unique
 * index from migration 20260921010000 decides the winner and the loser re-reads
 * the winner's row. The read here is only the fast path for the common case,
 * which is a connection that already exists.
 */
export const resolveConnection = async (
  runtime: ConsentRuntime,
  humanAccountId: string,
  oauthClientId: string,
): Promise<StoredConnection> => {
  const client = runtime.clients.get(oauthClientId);
  if (client === undefined) throw new ConsentError("CLIENT_NOT_REGISTERED");
  const existing = await runtime.connections.findForClient(
    humanAccountId,
    oauthClientId,
  );
  if (existing !== null) return existing.connection;
  const created = await runtime.connections.createForClient({
    id: newConnectionId(),
    principalLabel: principalLabelFor(client.family),
    humanAccountId,
    client: client.family,
    oauthClientId,
    environment: runtime.environment,
    preset: runtime.preset,
    status: "awaiting-consent",
    generation: 0,
    revokedAt: null,
    consentedAt: null,
  });
  if (created === null) throw new ConsentError("CONNECTION_NOT_CREATED", 500);
  return created.connection;
};
