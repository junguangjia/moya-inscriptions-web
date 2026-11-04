import type {
  AdminOpClass,
  AdminSaveEcho,
} from "@moya/contracts/internal/admin-mcp";

import { changedFieldNames } from "../audit";
import { okEnvelope } from "../envelope";
import { draftContent } from "../../editorial/content";
import { EditorialError } from "../../editorial/errors";
import { unboundEditorialIdentities } from "../../editorial/identities";
import { saveDraft } from "../../editorial/operations";
import { isMissingRecord } from "../../editorial/transaction";
import { articleContentSubset } from "../../editorial-content/approvals";
import { saveArticleDraft } from "../../editorial-content/operations";
import { requestKeyOf, type AdminOpContext } from "./define";

/**
 * Saves on admin_execute: the operation the Admin's batch route runs, plus what a
 * client needs from it here (admin-mcp-completion-v1 sections 7 and 10). An answer
 * shows which record it wrote, a removal is asked for by name, and a save that binds
 * a new permanent identity never runs directly.
 */

type SaveDocument = Readonly<Record<string, unknown>>;

interface SaveCommand extends Record<string, unknown> {
  readonly id?: number | string;
  readonly expectedRevision?: number;
  readonly allowRemoving?: boolean;
  readonly content: Readonly<Record<string, unknown>>;
}

export interface SavedAnswer {
  readonly id: number;
  readonly revision: number;
  readonly fingerprint: string;
  readonly replayed?: boolean;
  readonly supersededIntents?: readonly string[];
  readonly articleId?: string;
  readonly status?: "draft" | "published";
}

export type SaveSlug = "catalogs" | "articles" | "article-collections";

const readDraftOf = async (
  { req }: AdminOpContext,
  slug: SaveSlug,
  id: number | string,
): Promise<SaveDocument | undefined> => {
  try {
    return (await req.payload.findByID({
      collection: slug,
      id,
      draft: true,
      depth: 0,
      overrideAccess: false,
      req,
      user: req.user,
    })) as unknown as SaveDocument;
  } catch (error) {
    // No such record: the save itself answers that.
    if (isMissingRecord(error)) return undefined;
    throw error;
  }
};

// The class and the removal check read the same state of one target's one call.
const befores = new WeakMap<
  AdminOpContext,
  Promise<SaveDocument | undefined>
>();

export const beforeOf = (
  context: AdminOpContext,
  slug: SaveSlug,
  id: number | string,
) => {
  const known = befores.get(context);
  if (known !== undefined) return known;
  const read = readDraftOf(context, slug, id);
  befores.set(context, read);
  return read;
};

const sourceIdsOf = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.flatMap((item: { sourceId?: unknown }) =>
        typeof item?.sourceId === "string" ? [item.sourceId] : [],
      )
    : [];

const mediaIdsOf = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.flatMap((item: { mediaId?: unknown }) =>
        typeof item?.mediaId === "string" ? [item.mediaId] : [],
      )
    : [];

/**
 * What identity claims read on this save: the record's own two, and the provenance
 * the save leaves it with. The two cannot change, so a different one sent here stays
 * the save's own IDENTITY_IMMUTABLE and never reads as a new identity.
 */
export const classifyCatalogSave = async (
  raw: unknown,
  context: AdminOpContext,
): Promise<AdminOpClass> => {
  const { id, content } = raw as SaveCommand;
  if (id === undefined) return "irreversible";
  const before = await beforeOf(context, "catalogs", id);
  if (before === undefined) return "reversible";
  const identities = [
    String(before.catalogId),
    String(before.sourceId),
    ...sourceIdsOf(
      Object.hasOwn(content, "provenance")
        ? content.provenance
        : before.provenance,
    ),
  ];
  const unbound = await unboundEditorialIdentities(context.req, [
    ...new Set(identities),
  ]);
  return unbound.length > 0 ? "irreversible" : "reversible";
};

/** An Article's public id is set once, on create. An edit binds nothing. */
export const classifyArticleSave = async (
  raw: unknown,
): Promise<AdminOpClass> =>
  (raw as SaveCommand).id === undefined ? "irreversible" : "reversible";

const gone = (from: readonly string[], to: readonly string[]) => {
  const kept = new Set(to);
  return from.filter((item) => !kept.has(item));
};

export const removedBy = (
  before: SaveDocument,
  content: Readonly<Record<string, unknown>>,
): NonNullable<AdminSaveEcho["removedItems"]> => {
  const media = Object.hasOwn(content, "media")
    ? gone(mediaIdsOf(before.media), mediaIdsOf(content.media))
    : [];
  const provenance = Object.hasOwn(content, "provenance")
    ? gone(sourceIdsOf(before.provenance), sourceIdsOf(content.provenance))
    : [];
  return {
    ...(media.length > 0 ? { media } : {}),
    ...(provenance.length > 0 ? { provenance } : {}),
  };
};

/**
 * Read after the commit, so nothing here may read as a failed save. A record that
 * moved on since shows the later title, and says so. A restore knows what it dropped
 * only from what it wrote, so `removed` can read that too.
 */
export const echoOf = async (
  context: AdminOpContext,
  slug: SaveSlug,
  saved: SavedAnswer,
  before: SaveDocument | undefined,
  removed:
    | AdminSaveEcho["removedItems"]
    | ((after: SaveDocument) => AdminSaveEcho["removedItems"]),
  contentOf: (document: SaveDocument) => Record<string, unknown>,
): Promise<AdminSaveEcho & { readonly replayed?: boolean }> => {
  const answer: AdminSaveEcho & { readonly replayed?: boolean } = {
    id: saved.id,
    ...(saved.articleId ? { articleId: saved.articleId } : {}),
    revision: saved.revision,
    fingerprint: saved.fingerprint,
    ...(saved.status === undefined ? {} : { status: saved.status }),
    ...(saved.supersededIntents === undefined
      ? {}
      : { supersededIntents: [...saved.supersededIntents] }),
    ...(saved.replayed === undefined ? {} : { replayed: saved.replayed }),
  };
  try {
    const after = await readDraftOf(context, slug, saved.id);
    if (after === undefined) throw new Error("ECHO_UNREAD");
    const moved = after.revision !== saved.revision;
    const compared = before !== undefined && !saved.replayed && !moved;
    const gone = typeof removed === "function" ? removed(after) : removed;
    return {
      ...answer,
      // What it says now, so a replay of a publish since withdrawn never reads as live.
      ...(saved.status !== undefined &&
      (after._status === "draft" || after._status === "published")
        ? { status: after._status }
        : {}),
      ...(typeof after.catalogId === "string"
        ? { catalogId: after.catalogId }
        : {}),
      ...(typeof after.articleId === "string"
        ? { articleId: after.articleId }
        : {}),
      ...(typeof after.collectionId === "string"
        ? { collectionId: after.collectionId }
        : {}),
      ...(typeof after.title === "string" ? { title: after.title } : {}),
      ...(compared
        ? {
            changedFields: changedFieldNames(
              contentOf(before),
              contentOf(after),
            ),
            ...(gone !== undefined && Object.keys(gone).length > 0
              ? { removedItems: gone }
              : {}),
          }
        : {}),
      ...(moved
        ? { warnings: ["moved_since_save"] }
        : { noRereadNeeded: true }),
    };
  } catch {
    return { ...answer, warnings: ["echo_unread"] };
  }
};

export const saveCatalogDraft = async (
  raw: unknown,
  context: AdminOpContext,
) => {
  const { allowRemoving, ...command } = raw as SaveCommand;
  const before =
    command.id === undefined
      ? undefined
      : await beforeOf(context, "catalogs", command.id);
  // The revision check at the save decides: a record that moved answers that, and a
  // replay whose revision moved long ago never reads as a removal.
  const removed =
    before !== undefined && before.revision === command.expectedRevision
      ? removedBy(before, command.content)
      : {};
  const names = Object.keys(removed);
  if (names.length > 0 && allowRemoving !== true)
    throw new EditorialError("REMOVAL_NOT_ALLOWED", 409, names);
  const saved = await saveDraft(context.req, {
    ...command,
    idempotencyKey: requestKeyOf(context),
  });
  return okEnvelope(
    await echoOf(context, "catalogs", saved, before, removed, draftContent),
  );
};

export const saveArticle = async (raw: unknown, context: AdminOpContext) => {
  const { id } = raw as SaveCommand;
  const before =
    id === undefined ? undefined : await beforeOf(context, "articles", id);
  const saved = await saveArticleDraft(context.req, {
    ...(raw as SaveCommand),
    idempotencyKey: requestKeyOf(context),
  });
  return okEnvelope(
    await echoOf(
      context,
      "articles",
      saved,
      before,
      undefined,
      articleContentSubset,
    ),
  );
};
