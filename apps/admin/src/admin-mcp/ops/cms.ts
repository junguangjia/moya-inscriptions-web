import type { AdminOpName } from "@moya/contracts/internal/admin-mcp";

import {
  asynchronous,
  irreversibleOp,
  readOp,
  reversibleOp,
  type AdminOpEntry,
} from "./define";

type CmsOpName = Extract<
  AdminOpName,
  `${"catalog" | "approval" | "article" | "collection" | "media" | "document" | "catalog_search"}.${string}`
>;

const catalogs = { selectorSources: ["list.catalogs"] } as const;

/** Thin wrappers over the Local API under this key's user, with receipts. */
export const cmsOps: Readonly<Record<CmsOpName, AdminOpEntry>> = {
  "catalog.publish": reversibleOp(
    "Publish one Catalog; refuses until its images are ready.",
    "receipt",
    catalogs,
  ),
  "catalog.withdraw": reversibleOp(
    "Withdraw one Catalog from public reads.",
    "receipt",
    { ...catalogs, completion: asynchronous },
  ),
  "catalog.restore": reversibleOp(
    "Restore a Catalog version as a new draft.",
    "receipt",
    catalogs,
  ),
  "catalog.patch_text": reversibleOp(
    "Replace exact text in one long field, all or nothing.",
    "receipt",
  ),
  "catalog.duplicate": irreversibleOp(
    "Copy a Catalog under a new caller-supplied identity.",
    "receipt",
  ),
  "approval.revoke": reversibleOp(
    "Revoke an approval batch.",
    "state_idempotent",
  ),
  "article.publish": reversibleOp("Publish one Article.", "receipt"),
  "article.withdraw": reversibleOp("Withdraw one Article.", "receipt"),
  "article.restore": reversibleOp("Restore an Article version.", "receipt"),
  "article.duplicate": irreversibleOp(
    "Copy an Article under a new identity.",
    "receipt",
  ),
  "collection.save": reversibleOp("Create or edit one collection.", "receipt", {
    risesWhen: "the save binds an identity not yet bound",
  }),
  "collection.publish": reversibleOp("Publish one collection.", "receipt"),
  "collection.withdraw": reversibleOp("Withdraw one collection.", "receipt"),
  "collection.restore": reversibleOp(
    "Restore a collection version.",
    "receipt",
  ),
  "collection.duplicate": irreversibleOp(
    "Copy a collection under a new identity.",
    "receipt",
  ),
  "media.register_existing": reversibleOp(
    "Register bytes already stored under a media id.",
    "state_idempotent",
    { risesWhen: "the media id is not yet registered" },
  ),
  "media.register_upload": irreversibleOp(
    "Register uploaded bytes under a new media id.",
    "state_idempotent",
    { completion: asynchronous },
  ),
  "media.update_metadata": reversibleOp(
    "Edit a media row's editable metadata.",
    "cas_read_back",
  ),
  "document.lock_takeover": reversibleOp(
    "Take over a document lock; the Owner can take it back.",
    "cas_read_back",
  ),
  "document.lock_release": reversibleOp(
    "Release a lock this key holds.",
    "state_idempotent",
  ),
  "catalog_search.status": readOp("Search index counts and stale rows."),
  "catalog_search.rebuild": reversibleOp(
    "Rebuild the Catalog search index per record.",
    "state_idempotent",
  ),
};
