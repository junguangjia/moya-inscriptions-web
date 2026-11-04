import type {
  AdminFieldFacts,
  AdminGetView,
  AdminMcpEnvelope,
  AdminRecordState,
} from "@moya/contracts/internal/admin-mcp";
import type { PayloadRequest } from "payload";

import { okEnvelope } from "./envelope";
import {
  adminPathOf,
  factsOf,
  findDocuments,
  fingerprintOf,
  lockOf,
  locksOf,
  readLive,
  stateOf,
  titleOf,
} from "./records";
import type { CmsFamily, RecordDocument } from "./records";

/**
 * What every admin_get answer says about the record, because a read with no draft
 * flag gets the live row and the two differ silently otherwise.
 */

export interface PublicationFacts {
  readonly state: AdminRecordState;
  readonly publishedRevision: number | null;
  readonly hasUnpublishedChanges: boolean;
}

const asRevision = (value: unknown): number | null =>
  typeof value === "number" ? value : null;

export const publicationOf = async (
  req: PayloadRequest,
  family: CmsFamily,
  latest: RecordDocument,
): Promise<PublicationFacts> => {
  if (!family.versioned)
    return {
      state: "registered",
      publishedRevision: null,
      hasUnpublishedChanges: false,
    };
  const id = latest.id as number;
  const [row] = await findDocuments(req, family, {
    where: { id: { equals: id } },
    limit: 1,
    draft: false,
    select: { _status: true, revision: true },
  });
  const state = stateOf(latest._status, row?._status);
  if (row?._status !== "published")
    return { state, publishedRevision: null, hasUnpublishedChanges: true };
  const publishedRevision = asRevision(row.revision);
  if (row.revision === latest.revision)
    return { state, publishedRevision, hasUnpublishedChanges: false };
  // A save moves the revision whether or not the content changed. Stored content that
  // no longer parses has no fingerprint to compare, and that never reads as no change.
  const live = await readLive(req, family, id);
  const before = fingerprintOf(family, live);
  const after = fingerprintOf(family, latest);
  return {
    state,
    publishedRevision,
    hasUnpublishedChanges:
      before === null || after === null || before !== after,
  };
};

/** `doc` is the version this answer read; `publication` is always about the record. */
export const recordCommon = async (
  req: PayloadRequest,
  family: CmsFamily,
  doc: RecordDocument,
  publication: PublicationFacts,
  view: AdminGetView,
  readFrom: "draft" | "published" | "live" | "version",
) => {
  const id = doc.id as number;
  const lock = lockOf(await locksOf(req, family, [id]), family, id);
  const title = titleOf(family, doc);
  return {
    type: family.type,
    id,
    view,
    readFrom,
    state: publication.state,
    revision: asRevision(doc.revision),
    fingerprint: fingerprintOf(family, doc),
    publishedRevision: publication.publishedRevision,
    hasUnpublishedChanges: publication.hasUnpublishedChanges,
    ...(title === undefined ? {} : { title }),
    ...(typeof doc.updatedAt === "string" ? { updatedAt: doc.updatedAt } : {}),
    ...(lock === undefined ? {} : { lock }),
    adminPath: adminPathOf(family, id),
  };
};

export const readFromOf = (family: CmsFamily) =>
  family.versioned ? ("draft" as const) : ("live" as const);

export const outlineFacts = (
  family: CmsFamily,
  doc: RecordDocument,
  names?: readonly string[],
): readonly AdminFieldFacts[] =>
  family.fields
    .filter(({ name }) => names === undefined || names.includes(name))
    .map((spec) => factsOf(spec, doc));

/** Pointers to what a person wrote: everything that carries a value or a title. */
export const OUTLINE_UNTRUSTED = ["/data/title", "/data/fields/*/value"];

/** The two identities a skeleton copies from the record; the rest of it is ours. */
export const ACTIONS_UNTRUSTED = [
  "/data/actions/*/args/input/filter/catalogId",
  "/data/actions/*/args/mediaId",
];

/**
 * The default read: it answers "is the transcription there, did it change" in one
 * call, and no long text leaves.
 */
export const outlineData = async (
  req: PayloadRequest,
  family: CmsFamily,
  doc: RecordDocument,
  publication: PublicationFacts,
  readFrom: "draft" | "published" | "live",
  view: AdminGetView,
  names?: readonly string[],
) => ({
  ...(await recordCommon(req, family, doc, publication, view, readFrom)),
  lengthUnit: "codePoint",
  fields: outlineFacts(family, doc, names),
  // The master routes arrive in a later slice: never read this as "no master".
  ...(family.type === "catalog" ? { deepZoom: "not_available" } : {}),
});

/** editorial.read-draft for a key: the whole draft would not fit a text result. */
export const outlineEnvelope = async (
  req: PayloadRequest,
  family: CmsFamily,
  doc: RecordDocument,
): Promise<AdminMcpEnvelope> =>
  okEnvelope(
    await outlineData(
      req,
      family,
      doc,
      await publicationOf(req, family, doc),
      readFromOf(family),
      "outline",
    ),
    OUTLINE_UNTRUSTED,
  );
