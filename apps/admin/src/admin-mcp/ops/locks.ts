import {
  adminLockReleaseInputSchema,
  adminLockTakeoverInputSchema,
} from "@moya/contracts/internal/admin-mcp";
import type { AdminLockTakeoverEcho } from "@moya/contracts/internal/admin-mcp";
import { sql } from "@payloadcms/db-postgres";
import type { PayloadRequest } from "payload";

import { EditorialError } from "../../editorial/errors";
import {
  editorialTransaction,
  lockEditorialKey,
  withEditorialTransaction,
} from "../../editorial/transaction";
import { okEnvelope } from "../envelope";
import {
  CMS_FAMILIES,
  fingerprintOf,
  lockExpiryOf,
  lockIsLive,
  readLatest,
  titleOf,
  type CmsFamily,
} from "../records";
import { requireRow } from "./cms-writes";
import type { AdminOpContext } from "./define";

/**
 * Taking over a document lock (admin-mcp-completion-v1 section 10): the same rewrite
 * of the lock row's user as the Admin's take-over, and never overrideLock, which would
 * delete the row with no record. The editorial key is what a save holds from before
 * its lock check, so a save either finished first, and the answer carries the revision
 * it left, or meets this holder and answers 423.
 */

/** A known family or nothing: this also runs on unchecked arguments, for the audit row. */
export const onLockedRecord = (input: unknown) => {
  const { type, id } = input as { type?: unknown; id?: unknown };
  return {
    type:
      typeof type === "string" && Object.hasOwn(CMS_FAMILIES, type)
        ? type
        : "document",
    ...(id === undefined ? {} : { id: String(id) }),
  };
};

const documentKeyOf = ({ type }: CmsFamily, id: number) =>
  type === "media" ? `media:${id}` : `document:${id}`;

/** The row Payload's own check reads: the newest, live or not. */
const lockRowOf = async (
  req: PayloadRequest,
  family: CmsFamily,
  id: number,
) => {
  const { docs } = await req.payload.find({
    collection: "payload-locked-documents",
    where: {
      and: [
        { "document.relationTo": { equals: family.slug } },
        { "document.value": { equals: id } },
      ],
    },
    sort: "-updatedAt",
    depth: 0,
    limit: 1,
    pagination: false,
    overrideAccess: false,
    req,
    user: req.user,
  });
  return docs[0];
};

/**
 * Compared under the row's own lock: the Admin touches a held lock with no editorial
 * key, as often as every 10 s while its holder types.
 */
const lockUnmoved = async (
  req: PayloadRequest,
  lockId: number,
  lastEditedAt: string,
) => {
  const db = await editorialTransaction(req);
  const { rows } = await db.execute(sql`
    SELECT updated_at = ${lastEditedAt}::timestamptz AS unmoved
    FROM payload_locked_documents WHERE id = ${lockId} FOR UPDATE`);
  return rows[0]?.unmoved === true;
};

export const takeOverLock = async (raw: unknown, { req }: AdminOpContext) => {
  const { type, id, expected } = adminLockTakeoverInputSchema.parse(raw);
  const family = CMS_FAMILIES[type];
  const row = await requireRow(req, family, id);
  const answer = await withEditorialTransaction(
    req,
    async (): Promise<AdminLockTakeoverEcho> => {
      await lockEditorialKey(req, documentKeyOf(family, row));
      const lock = await lockRowOf(req, family, row);
      if (lock === undefined || !lockIsLive(req, family, lock))
        throw new EditorialError("LOCK_NOT_HELD", 409);
      // No receipt: the row itself says a retry's takeover already happened.
      const mine = lock.user?.value === req.user?.id;
      if (
        !mine &&
        (lock.id !== expected.lockId ||
          lock.user?.value !== expected.holderUserId ||
          !(await lockUnmoved(req, lock.id, expected.lastEditedAt)))
      )
        throw new EditorialError("LOCK_CHANGED", 409);
      const held = mine
        ? lock
        : await req.payload.update({
            collection: "payload-locked-documents",
            id: lock.id,
            data: { user: { relationTo: "users", value: req.user!.id } },
            depth: 0,
            overrideAccess: false,
            req,
            user: req.user,
          });
      const document = await readLatest(req, family, row);
      const title = titleOf(family, document);
      return {
        type,
        id: row,
        ...(title === undefined ? {} : { title }),
        lockId: lock.id,
        expiresAt: lockExpiryOf(req, family, held),
        ...(family.versioned ? { revision: Number(document.revision) } : {}),
        fingerprint: fingerprintOf(family, document),
        ...(mine ? { replayed: true as const } : {}),
      };
    },
  );
  return okEnvelope(answer);
};

export const releaseLock = async (raw: unknown, { req }: AdminOpContext) => {
  const { type, id } = adminLockReleaseInputSchema.parse(raw);
  const family = CMS_FAMILIES[type];
  const row = await requireRow(req, family, id);
  await withEditorialTransaction(req, async () => {
    await lockEditorialKey(req, documentKeyOf(family, row));
    const lock = await lockRowOf(req, family, row);
    // Only this account's own: a lock past its time holds nothing to give back.
    if (lock === undefined) throw new EditorialError("ALREADY_RELEASED", 409);
    if (lock.user?.value !== req.user?.id)
      throw new EditorialError(
        lockIsLive(req, family, lock) ? "DOCUMENT_LOCKED" : "ALREADY_RELEASED",
        lockIsLive(req, family, lock) ? 423 : 409,
      );
    await req.payload.delete({
      collection: "payload-locked-documents",
      id: lock.id,
      depth: 0,
      overrideAccess: false,
      req,
      user: req.user,
    });
  });
  return okEnvelope({ type, id: row, released: true });
};
