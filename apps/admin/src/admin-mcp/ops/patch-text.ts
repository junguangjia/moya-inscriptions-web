import { adminPatchTextInputSchema } from "@moya/contracts/internal/admin-mcp";
import type {
  AdminPatchEcho,
  AdminPatchTextInput,
} from "@moya/contracts/internal/admin-mcp";

import { relationshipID } from "../../editorial/collections";
import { draftContent, requestFingerprint } from "../../editorial/content";
import { EditorialError } from "../../editorial/errors";
import {
  numericID,
  receiptedCommand,
  writeDraftPatch,
} from "../../editorial/operations";
import { lockEditorialKey } from "../../editorial/transaction";
import { okEnvelope } from "../envelope";
import {
  CMS_FAMILIES,
  fieldTextOf,
  readLatest,
  type RecordDocument,
} from "../records";
import { codePointLength, textHash } from "../text-window";
import { requestKeyOf, type AdminOpContext } from "./define";
import { beforeOf, echoOf, type SavedAnswer } from "./saves";
import { requireRow } from "./cms-writes";

/**
 * catalog.patch_text (admin-mcp-completion-v1 section 10): a correction in a long
 * field with no retyping. All or nothing, because for stele text a half-applied
 * correction is worse than a failed one. It only moves text, so it binds no identity
 * and stays direct, and it writes through the draft save, so validation and hooks run.
 */

type Edit = AdminPatchTextInput["edits"][number];
type PatchFacts = Pick<
  AdminPatchEcho,
  "field" | "oldHash" | "newHash" | "newTotalLength" | "ranges"
>;

// Each edit's place is shown with this much around it, for this many edits. Any more
// could not fit one answer, and a range with no context still gives its offset.
const CONTEXT_CHARS = 20;
const CONTEXT_RANGES = 20;

/**
 * Where oldText is, unit by unit, overlaps included, so a count of one really means
 * one place. Stops as soon as the answer is known. A well-formed oldText, which the
 * contract requires, can only start and end on the edges of a character.
 */
const placesOf = (text: string, { oldText, occurrence }: Edit) => {
  const wanted = occurrence ?? 2;
  const places: number[] = [];
  let at = text.indexOf(oldText);
  while (at !== -1 && places.length < wanted) {
    places.push(at);
    at = text.indexOf(oldText, at + 1);
  }
  return places;
};

const refuse = (code: string, editIndexes: readonly number[]): never => {
  throw new EditorialError(
    code,
    409,
    editIndexes.map((index) => `edits.${index}`),
  );
};

/** Each edit reads the text as it was, so their order changes nothing. */
const applyEdits = (text: string, edits: readonly Edit[]) => {
  const places = edits.map((edit) => placesOf(text, edit));
  const indexesWhere = (
    test: (found: readonly number[], edit: Edit) => boolean,
  ) =>
    edits.flatMap((edit, index) => (test(places[index]!, edit) ? [index] : []));
  const missing = indexesWhere(
    (found, { occurrence }) => found.length < (occurrence ?? 1),
  );
  if (missing.length > 0) refuse("PATCH_NO_MATCH", missing);
  const several = indexesWhere(
    (found, { occurrence }) => occurrence === undefined && found.length > 1,
  );
  if (several.length > 0) refuse("PATCH_MULTIPLE_MATCHES", several);
  const chosen = edits
    .map((edit, index) => ({
      edit,
      index,
      at: places[index]![places[index]!.length - 1]!,
    }))
    .sort((left, right) => left.at - right.at);
  const overlapping = chosen.flatMap(({ at, index }, position) => {
    const previous = chosen[position - 1];
    return previous !== undefined &&
      previous.at + previous.edit.oldText.length > at
      ? [previous.index, index]
      : [];
  });
  if (overlapping.length > 0)
    refuse("PATCH_OVERLAP", [...new Set(overlapping)]);

  const pieces: string[] = [];
  const spans: { offset: number; oldText: string; newText: string }[] = [];
  let read = 0;
  let written = 0;
  for (const {
    at,
    edit: { oldText, newText },
  } of chosen) {
    const between = text.slice(read, at);
    written += codePointLength(between);
    pieces.push(between, newText);
    spans.push({ offset: written, oldText, newText });
    written += codePointLength(newText);
    read = at + oldText.length;
  }
  pieces.push(text.slice(read));
  return { patched: pieces.join(""), spans };
};

const patchedValue = (
  latest: RecordDocument,
  field: AdminPatchTextInput["field"],
  patched: string,
) => {
  const current = latest[field];
  return current !== null && typeof current === "object"
    ? { ...current, value: patched }
    : patched;
};

export const patchCatalogText = async (
  raw: unknown,
  context: AdminOpContext,
) => {
  const parsed = adminPatchTextInputSchema.parse(raw);
  const { req } = context;
  const family = CMS_FAMILIES.catalog;
  const id = await requireRow(req, family, parsed.catalogId);
  const before = await beforeOf(context, "catalogs", id);
  const { field, edits, expected } = parsed;
  const saved = await receiptedCommand<SavedAnswer & PatchFacts>(
    req,
    requestKeyOf(context),
    requestFingerprint({ operation: "catalog.patch_text", ...parsed }),
    "patch-text",
    async () => {
      await lockEditorialKey(req, `document:${id}`);
      const latest = await readLatest(req, family, id);
      if (
        latest.revision !== expected.revision ||
        family.fingerprint(latest) !== expected.fingerprint
      )
        throw new EditorialError("REVISION_CONFLICT", 409);
      const current = fieldTextOf(family, latest, field);
      const text = current.found && !current.withheld ? current.text : "";
      const { patched, spans } = applyEdits(text, edits);
      const written = await writeDraftPatch(req, id, expected.revision, {
        [field]: patchedValue(latest, field, patched),
      });
      const points = Array.from(patched);
      return {
        ...written,
        field,
        oldHash: textHash(text),
        newHash: textHash(patched),
        newTotalLength: points.length,
        ranges: spans.map(({ offset, oldText, newText }, index) => {
          const newLength = codePointLength(newText);
          return {
            offset,
            oldLength: codePointLength(oldText),
            newLength,
            ...(index < CONTEXT_RANGES
              ? {
                  before: points
                    .slice(Math.max(0, offset - CONTEXT_CHARS), offset)
                    .join(""),
                  after: points
                    .slice(
                      offset + newLength,
                      offset + newLength + CONTEXT_CHARS,
                    )
                    .join(""),
                }
              : {}),
          };
        }),
      };
    },
    ({ id: catalog, revision, fingerprint }) => ({
      catalog,
      revision,
      fingerprint,
    }),
    (receipt) => ({
      id: numericID(relationshipID(receipt.catalog)),
      revision: Number(receipt.revision),
      fingerprint: String(receipt.fingerprint),
    }),
  );
  const echo = await echoOf(
    context,
    "catalogs",
    saved,
    before,
    undefined,
    draftContent,
  );
  const {
    field: patchedField,
    oldHash,
    newHash,
    newTotalLength,
    ranges,
  } = saved;
  return okEnvelope({
    ...echo,
    ...(patchedField === undefined
      ? {}
      : {
          field: patchedField,
          oldHash,
          newHash,
          newTotalLength,
          ranges,
        }),
  });
};
