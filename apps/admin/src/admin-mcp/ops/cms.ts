import {
  adminApprovalRevokeInputSchema,
  adminCollectionSaveInputSchema,
  adminLockReleaseEchoSchema,
  adminLockReleaseInputSchema,
  adminLockTakeoverEchoSchema,
  adminLockTakeoverInputSchema,
  adminMediaRegisterInputSchema,
  adminMediaUpdateInputSchema,
  adminPatchEchoSchema,
  adminPatchTextInputSchema,
  adminPublicationInputSchema,
  adminRestoreInputSchema,
  adminSaveEchoSchema,
} from "@moya/contracts/internal/admin-mcp";
import type { AdminOpName } from "@moya/contracts/internal/admin-mcp";

import {
  answerMediaRegistration,
  catalogWithdrawal,
  classifyCollectionSave,
  classifyMediaRegistration,
  publishRecord,
  restoreRecord,
  revokeApproval,
  saveCollection,
  updateMediaMetadata,
  withdrawRecord,
} from "./cms-writes";
import {
  asynchronous,
  example,
  irreversibleOp,
  onField,
  readOp,
  reversibleOp,
  type AdminOpEntry,
} from "./define";
import { onLockedRecord, releaseLock, takeOverLock } from "./locks";
import { patchCatalogText } from "./patch-text";

type CmsOpName = Extract<
  AdminOpName,
  `${"catalog" | "approval" | "article" | "collection" | "media" | "document" | "catalog_search"}.${string}`
>;

const catalogs = { selectorSources: ["list.catalogs"] } as const;

const expected = { revision: 4, fingerprint: example.digest };

const onRecord = (type: "catalog" | "article" | "collection") =>
  ({
    target: onField(type, "id"),
    output: { ai: adminSaveEchoSchema },
    untrusted: [
      "/data/results/*/title",
      `/data/results/*/${type}Id`,
      "/data/results/*/removedItems/media/*",
      "/data/results/*/removedItems/provenance/*",
    ],
  }) as const;

const publication = (type: "catalog" | "article" | "collection") =>
  ({
    ...onRecord(type),
    input: adminPublicationInputSchema,
    example: { id: 7, expected },
  }) as const;

const restoration = (type: "catalog" | "article" | "collection") =>
  ({
    ...onRecord(type),
    input: adminRestoreInputSchema,
    run: restoreRecord(type),
    example: { id: 7, versionId: 21, expected },
  }) as const;

/** Thin wrappers over the Local API under this key's user, with receipts. */
export const cmsOps: Readonly<Record<CmsOpName, AdminOpEntry>> = {
  "catalog.publish": reversibleOp(
    "Publish one Catalog; refuses until its images are ready.",
    "receipt",
    { ...catalogs, ...publication("catalog"), run: publishRecord("catalog") },
  ),
  "catalog.withdraw": reversibleOp(
    "Withdraw one Catalog from public reads.",
    "receipt",
    {
      ...catalogs,
      ...publication("catalog"),
      completion: catalogWithdrawal,
      run: withdrawRecord("catalog"),
    },
  ),
  "catalog.restore": reversibleOp(
    "Restore a Catalog version as a new draft.",
    "receipt",
    { ...catalogs, ...restoration("catalog") },
  ),
  "catalog.patch_text": reversibleOp(
    "Replace exact text in one long field, all or nothing.",
    "receipt",
    {
      input: adminPatchTextInputSchema,
      output: { ai: adminPatchEchoSchema },
      run: patchCatalogText,
      target: onField("catalog", "catalogId"),
      untrusted: [
        "/data/results/*/title",
        "/data/results/*/catalogId",
        "/data/results/*/ranges/*/before",
        "/data/results/*/ranges/*/after",
      ],
      example: {
        catalogId: 7,
        field: "transcription",
        edits: [{ oldText: "Synthetic", newText: "Corrected" }],
        expected,
      },
    },
  ),
  "catalog.duplicate": irreversibleOp(
    "Copy a Catalog under a new caller-supplied identity.",
    "receipt",
  ),
  "approval.revoke": reversibleOp(
    "Revoke an approval batch.",
    "state_idempotent",
    {
      input: adminApprovalRevokeInputSchema,
      run: revokeApproval,
      target: onField("approval", "approvalId"),
      example: { approvalId: 3, type: "catalog" },
    },
  ),
  "article.publish": reversibleOp("Publish one Article.", "receipt", {
    ...publication("article"),
    run: publishRecord("article"),
  }),
  "article.withdraw": reversibleOp("Withdraw one Article.", "receipt", {
    ...publication("article"),
    run: withdrawRecord("article"),
  }),
  "article.restore": reversibleOp(
    "Restore an Article version.",
    "receipt",
    restoration("article"),
  ),
  "article.duplicate": irreversibleOp(
    "Copy an Article under a new identity.",
    "receipt",
  ),
  "collection.save": reversibleOp("Create or edit one collection.", "receipt", {
    ...onRecord("collection"),
    risesWhen: "the save binds an identity not yet bound",
    classify: classifyCollectionSave,
    input: adminCollectionSaveInputSchema,
    run: saveCollection,
    example: { id: 7, expected, content: { title: "Synthetic title" } },
  }),
  "collection.publish": reversibleOp("Publish one collection.", "receipt", {
    ...publication("collection"),
    run: publishRecord("collection"),
  }),
  "collection.withdraw": reversibleOp("Withdraw one collection.", "receipt", {
    ...publication("collection"),
    run: withdrawRecord("collection"),
  }),
  "collection.restore": reversibleOp(
    "Restore a collection version.",
    "receipt",
    restoration("collection"),
  ),
  "collection.duplicate": irreversibleOp(
    "Copy a collection under a new identity.",
    "receipt",
  ),
  "media.register_existing": reversibleOp(
    "Register bytes already stored under a media id.",
    "state_idempotent",
    {
      risesWhen: "the media id is not yet registered",
      classify: classifyMediaRegistration,
      input: adminMediaRegisterInputSchema,
      run: answerMediaRegistration,
      target: onField("media", "mediaId"),
      untrusted: ["/data/results/*/mediaId"],
      example: {
        mediaId: "synthetic-media",
        catalogId: "synthetic-catalog",
        objectKey: "catalog/synthetic.png",
        sha256: example.digest,
        mimeType: "image/png",
        filesize: 1024,
        width: 3,
        height: 2,
        alt: "Synthetic original",
      },
    },
  ),
  "media.register_upload": irreversibleOp(
    "Register uploaded bytes under a new media id.",
    "state_idempotent",
    { completion: asynchronous },
  ),
  "media.update_metadata": reversibleOp(
    "Edit a media row's alt; a Catalog keeps its own copy until it is saved.",
    "cas_read_back",
    {
      input: adminMediaUpdateInputSchema,
      run: updateMediaMetadata,
      target: onField("media", "id"),
      untrusted: [
        "/data/results/*/title",
        "/data/results/*/mediaId",
        "/data/results/*/catalogId",
      ],
      example: {
        id: 7,
        alt: "Synthetic original",
        expected: { fingerprint: example.digest },
      },
    },
  ),
  "document.lock_takeover": reversibleOp(
    "Take over a lock, get the revision; the holder's unsaved edits are not kept.",
    "cas_read_back",
    {
      input: adminLockTakeoverInputSchema,
      output: { ai: adminLockTakeoverEchoSchema },
      run: takeOverLock,
      target: onLockedRecord,
      untrusted: ["/data/results/*/title"],
      example: {
        type: "catalog",
        id: 7,
        expected: {
          lockId: 3,
          holderUserId: 1,
          lastEditedAt: "2026-11-04T10:00:00.000Z",
        },
        reason: "Synthetic reason",
      },
    },
  ),
  "document.lock_release": reversibleOp(
    "Give back a lock this credential's account holds, after a takeover with no save.",
    "state_idempotent",
    {
      input: adminLockReleaseInputSchema,
      output: { ai: adminLockReleaseEchoSchema },
      run: releaseLock,
      target: onLockedRecord,
      example: { type: "catalog", id: 7 },
    },
  ),
  "catalog_search.status": readOp("Search index counts and stale rows."),
  "catalog_search.rebuild": reversibleOp(
    "Rebuild the Catalog search index per record.",
    "state_idempotent",
  ),
};
