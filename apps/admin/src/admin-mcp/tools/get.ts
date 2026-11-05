import { editorialPublishSchema } from "@moya/contracts/internal/editorial";
import {
  ADMIN_CMS_RECORD_TYPES,
  adminGetDataSchema,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminCmsRecordType,
  AdminGetInput,
  AdminGetView,
  AdminMcpEnvelope,
  AdminMcpNext,
  AdminRender,
} from "@moya/contracts/internal/admin-mcp";
import { APIError, type PayloadRequest } from "payload";

import { draftContent } from "../../editorial/content";
import { EditorialError } from "../../editorial/errors";
import { isMissingRecord } from "../../editorial/transaction";
import { validateCatalogMedia } from "../../media/validation";
import { adminPreviewLocation, previewCatalogDetail } from "../../preview";
import { actionsFor } from "../actions-for";
import type { ActionScope } from "../actions-for";
import { failedEnvelope, inputInvalidEnvelope, okEnvelope } from "../envelope";
import {
  ACTIONS_UNTRUSTED,
  OUTLINE_UNTRUSTED,
  outlineData,
  publicationOf,
  readFromOf,
  recordCommon,
} from "../record-views";
import type { PublicationFacts } from "../record-views";
import {
  accountKindsOf,
  changedFieldsBetween,
  CMS_FAMILIES,
  CREDENTIAL_URL,
  factsOf,
  fieldTextOf,
  firstDifferenceOffset,
  fullFieldOf,
  holdsWithheldLink,
  INLINE_TEXT_CHARS,
  readLatest,
  readLive,
  rowIdOf,
  statefulValue,
} from "../records";
import type { CmsFamily, RecordDocument } from "../records";
import { codePointLength, textHash } from "../text-window";
import {
  communityGetEnvelope,
  communityFieldNames,
  isCommunityArticleId,
} from "./get-community";
import { nextOf, windowOfField } from "./get-window";

export { GET_TOOL_NAME } from "./get-window";

export const GET_DESCRIPTION = `Read one record, and always say which version was read. Default outline: per-field state, length, hash, no long text. {type:"catalog",id:7}, {type:"report",id:"report-..."}. Long text in windows, offsets in code points: {type,id,field:"transcription",offset}. Inside one field: {type,id,field:"transcription",find:{text:"..."}}. view also full, published, preview, history, diff; a community record has outline, full and field only.`;

const isCms = (type: string): type is AdminCmsRecordType =>
  (ADMIN_CMS_RECORD_TYPES as readonly string[]).includes(type);

type Scope = ActionScope;

const VERSIONED_VIEWS: readonly AdminGetView[] = [
  "published",
  "preview",
  "history",
  "diff",
];

const viewOf = (input: AdminGetInput): AdminGetView =>
  input.view ??
  (input.field !== undefined || input.find !== undefined ? "field" : "outline");

const FIELD_NAMES = (family: CmsFamily) =>
  family.fields.map(({ name }) => name);

const unknownFields = (family: CmsFamily, names: readonly string[]) =>
  names.filter((name) => !FIELD_NAMES(family).includes(name));

const invalidField = (family: CmsFamily, path: string) =>
  inputInvalidEnvelope([
    {
      path: [path],
      code: "unknown_field",
      allowedKeys: [...FIELD_NAMES(family)],
    },
  ]);

const answered = (data: unknown, untrusted: readonly string[]) =>
  okEnvelope(adminGetDataSchema.parse(data), untrusted);

/** A stored link that does not leave is named as withheld, never read as no link. */
const excludingCredentialUrls = (envelope: AdminMcpEnvelope) => ({
  ...envelope,
  meta: { ...envelope.meta, excluded: [CREDENTIAL_URL] },
});

const withActions = (
  common: Awaited<ReturnType<typeof recordCommon>>,
  family: CmsFamily,
  doc: RecordDocument,
  scope: Scope,
) => {
  const actions = actionsFor(
    {
      type: family.type,
      id: common.id,
      state: common.state,
      revision: common.revision,
      fingerprint: common.fingerprint,
      lock: common.lock,
      ...(family.type === "catalog"
        ? { catalogId: String(doc.catalogId) }
        : {}),
      ...(family.type === "media" ? { mediaId: String(doc.mediaId) } : {}),
    },
    scope,
  );
  return actions.length === 0 ? common : { ...common, actions: [...actions] };
};

const outlineView = async (
  req: PayloadRequest,
  family: CmsFamily,
  doc: RecordDocument,
  publication: PublicationFacts,
  input: AdminGetInput,
  scope: Scope,
) => {
  if (
    input.fields !== undefined &&
    unknownFields(family, input.fields).length > 0
  )
    return invalidField(family, "fields");
  const data = await outlineData(
    req,
    family,
    doc,
    publication,
    readFromOf(family),
    "outline",
    input.fields,
  );
  return answered({ ...data, ...withActions(data, family, doc, scope) }, [
    ...OUTLINE_UNTRUSTED,
    ...ACTIONS_UNTRUSTED,
  ]);
};

const fullView = async (
  req: PayloadRequest,
  family: CmsFamily,
  doc: RecordDocument,
  publication: PublicationFacts,
  input: AdminGetInput,
  scope: Scope,
) => {
  if (
    input.fields !== undefined &&
    unknownFields(family, input.fields).length > 0
  )
    return invalidField(family, "fields");
  const common = await recordCommon(
    req,
    family,
    doc,
    publication,
    "full",
    readFromOf(family),
  );
  const specs = family.fields.filter(
    ({ name }) => input.fields === undefined || input.fields.includes(name),
  );
  const envelope = answered(
    {
      ...withActions(common, family, doc, scope),
      lengthUnit: "codePoint",
      fields: specs.map((spec) => fullFieldOf(spec, doc)),
    },
    [...OUTLINE_UNTRUSTED, ...ACTIONS_UNTRUSTED],
  );
  return specs.some((spec) => holdsWithheldLink(spec, doc))
    ? excludingCredentialUrls(envelope)
    : envelope;
};

/** A bounded window, or the matches inside one field. */
const fieldView = async (
  req: PayloadRequest,
  family: CmsFamily,
  doc: RecordDocument,
  publication: PublicationFacts,
  input: AdminGetInput,
  readFrom: "draft" | "published" | "live",
): Promise<AdminMcpEnvelope> => {
  if (input.field === undefined)
    return inputInvalidEnvelope([{ path: ["field"], code: "required" }]);
  const located = fieldTextOf(family, doc, input.field);
  if (!located.found) return invalidField(family, "field");
  const common = await recordCommon(
    req,
    family,
    doc,
    publication,
    input.view ?? "field",
    readFrom,
  );
  // No length, hash, count or empty text: any of them would read as an answer.
  if (located.withheld)
    return excludingCredentialUrls(
      answered({ ...common, field: input.field, fieldState: "WITHHELD" }, [
        "/data/title",
      ]),
    );
  return windowOfField(common, input, located, answered);
};

const publishedView = async (
  req: PayloadRequest,
  family: CmsFamily,
  latest: RecordDocument,
  publication: PublicationFacts,
  input: AdminGetInput,
) => {
  if (publication.publishedRevision === null) {
    const common = await recordCommon(
      req,
      family,
      latest,
      publication,
      "published",
      "published",
    );
    // Nothing is live, so no revision or fingerprint can describe what is.
    return answered(
      { ...common, revision: null, fingerprint: null, published: false },
      ["/data/title"],
    );
  }
  const live = await readLive(req, family, latest.id as number);
  if (input.field !== undefined || input.find !== undefined)
    return fieldView(req, family, live, publication, input, "published");
  if (
    input.fields !== undefined &&
    unknownFields(family, input.fields).length > 0
  )
    return invalidField(family, "fields");
  return answered(
    {
      ...(await outlineData(
        req,
        family,
        live,
        publication,
        "published",
        "published",
        input.fields,
      )),
      published: true,
    },
    OUTLINE_UNTRUSTED,
  );
};

const NOWHERE_FOR_PREVIEW_MEDIA = () => new URL("https://preview.invalid/");

const boundedPreviewText = (name: string, value: unknown) => {
  if (typeof value !== "string" || codePointLength(value) <= INLINE_TEXT_CHARS)
    return value;
  return {
    length: codePointLength(value),
    hash: textHash(value),
    head: Array.from(value).slice(0, INLINE_TEXT_CHARS).join(""),
    windowed: name,
  };
};

/**
 * The page's own projection, in the size a text result allows. An image becomes its
 * media id, so no address reaches the model, and a citation says it has a link: the
 * link itself is in view=full, unless it carries a credential.
 */
const projectionOf = (
  detail: Awaited<ReturnType<typeof previewCatalogDetail>>,
) => {
  const { media, representativeMedia, sourceCitations, ...rest } = detail;
  return {
    ...Object.fromEntries(
      Object.entries(rest).map(([name, value]) => [
        name,
        boundedPreviewText(name, value),
      ]),
    ),
    ...(representativeMedia === undefined
      ? {}
      : { representativeMediaId: representativeMedia.id }),
    media: media.map(({ id, width, height, alt }) => ({
      mediaId: id,
      width,
      height,
      alt,
    })),
    sourceCitations: sourceCitations.map(({ url, ...citation }) => ({
      ...citation,
      ...(url === undefined ? {} : { hasUrl: true }),
    })),
  };
};

const issueOf = (error: unknown) =>
  error instanceof EditorialError
    ? { path: error.fields, code: error.code }
    : error instanceof APIError
      ? { path: [], code: error.message }
      : undefined;

/** Why this record could not go live now. Paths and codes, never the content. */
const publishabilityIssues = async (
  req: PayloadRequest,
  doc: RecordDocument,
): Promise<readonly { path: readonly unknown[]; code: string }[]> => {
  let content: ReturnType<typeof draftContent>;
  try {
    content = draftContent(doc);
  } catch (error) {
    // Stored content that no longer parses cannot go live, and that is the answer.
    const issue = issueOf(error);
    if (issue === undefined) throw error;
    return [issue];
  }
  const checked = editorialPublishSchema.safeParse(content);
  const schemaIssues = checked.success
    ? []
    : checked.error.issues.map(({ path, code }) => ({ path, code }));
  try {
    await validateCatalogMedia(req, content, { publishing: true });
    return schemaIssues;
  } catch (error) {
    const issue = issueOf(error);
    if (issue === undefined) throw error;
    return [...schemaIssues, issue];
  }
};

const renderOf = (doc: RecordDocument, family: CmsFamily): AdminRender => {
  if (family.type !== "catalog")
    return { renderAvailable: false, reason: "NO_PREVIEW_PAGE" };
  const location = adminPreviewLocation(doc.id);
  return "href" in location
    ? {
        renderAvailable: true,
        renderPath: new URL(location.href).pathname,
      }
    : { renderAvailable: false, reason: location.reason };
};

const previewView = async (
  req: PayloadRequest,
  family: CmsFamily,
  doc: RecordDocument,
  publication: PublicationFacts,
  scope: Scope,
) => {
  const common = await recordCommon(
    req,
    family,
    doc,
    publication,
    "preview",
    "draft",
  );
  const live =
    publication.publishedRevision === null
      ? undefined
      : await readLive(req, family, doc.id as number);
  const diff = {
    againstRevision: publication.publishedRevision,
    changedFields: changedFieldsBetween(family, live, doc).map(
      ({ name }) => name,
    ),
  };
  const base = { ...withActions(common, family, doc, scope), diff };
  if (family.type !== "catalog") {
    const envelope = answered(
      {
        ...base,
        ...renderOf(doc, family),
        lengthUnit: "codePoint",
        fields: family.fields.map((spec) => fullFieldOf(spec, doc)),
      },
      [...OUTLINE_UNTRUSTED, ...ACTIONS_UNTRUSTED],
    );
    return family.fields.some((spec) => holdsWithheldLink(spec, doc))
      ? excludingCredentialUrls(envelope)
      : envelope;
  }
  const issues = await publishabilityIssues(req, doc);
  try {
    const detail = await previewCatalogDetail(
      req,
      doc.id,
      NOWHERE_FOR_PREVIEW_MEDIA,
    );
    return answered(
      {
        ...base,
        ...renderOf(doc, family),
        issues,
        projection: projectionOf(detail),
      },
      ["/data/title", "/data/projection", ...ACTIONS_UNTRUSTED],
    );
  } catch (error) {
    if (error instanceof APIError && error.message === "PREVIEW_INCOMPLETE")
      return answered(
        {
          ...base,
          renderAvailable: false,
          reason: "PREVIEW_INCOMPLETE",
          issues,
        },
        ["/data/title", ...ACTIONS_UNTRUSTED],
      );
    const issue = issueOf(error);
    if (issue === undefined) throw error;
    return answered(
      {
        ...base,
        ...renderOf(doc, family),
        // The page reads the same stored content, so it can meet the same refusal.
        issues: issues.some(({ code }) => code === issue.code)
          ? issues
          : [...issues, issue],
      },
      ["/data/title", ...ACTIONS_UNTRUSTED],
    );
  }
};

const HISTORY_PAGE = 20;

/** Field names per version, against the one before it, with who saved it. */
const historyView = async (
  req: PayloadRequest,
  family: CmsFamily,
  doc: RecordDocument,
  publication: PublicationFacts,
  input: AdminGetInput,
) => {
  const common = await recordCommon(
    req,
    family,
    doc,
    publication,
    "history",
    "draft",
  );
  const { docs } = await req.payload.findVersions({
    collection: family.slug as "catalogs",
    where: {
      and: [
        { parent: { equals: doc.id as number } },
        ...(input.cursor === undefined
          ? []
          : [{ id: { less_than: input.cursor } }]),
      ],
    },
    sort: "-id",
    // One more than a page, so the last row still has a version to compare with.
    limit: HISTORY_PAGE + 1,
    pagination: false,
    depth: 0,
    overrideAccess: false,
    req,
    user: req.user,
  });
  const rows = docs as unknown as readonly {
    id: number;
    createdAt: string;
    updatedAt: string;
    autosave?: boolean | null;
    version: RecordDocument;
  }[];
  const page = rows.slice(0, HISTORY_PAGE);
  const kinds = await accountKindsOf(req, [
    ...new Set(page.map(({ version }) => version.lastEditedBy).filter(Boolean)),
  ]);
  const versions = page.map((row, index) => {
    const older = rows[index + 1];
    const editor = row.version.lastEditedBy;
    return {
      versionId: row.id,
      revision: row.version.revision,
      status: row.version._status,
      at: row.updatedAt,
      ...(editor === undefined || editor === null
        ? {}
        : { editor: { id: editor, kind: kinds.get(editor) ?? "unknown" } }),
      ...(row.autosave ? { autosave: true } : {}),
      // The oldest kept, so its fields read as set rather than as changed.
      ...(older === undefined ? { oldest: true } : {}),
      changedFields: changedFieldsBetween(
        family,
        older?.version,
        row.version,
      ).map(({ name }) => name),
    };
  });
  const last = page.at(-1);
  return {
    ...answered({ ...common, versions }, ["/data/title"]),
    ...(rows.length > HISTORY_PAGE && last !== undefined
      ? { next: nextOf(input, { cursor: last.id }) }
      : {}),
  };
};

/** A version of this record, the draft, or the live row; undefined if not live. */
const versionNamed = async (
  req: PayloadRequest,
  family: CmsFamily,
  latest: RecordDocument,
  publication: PublicationFacts,
  name: number | "draft" | "published",
): Promise<RecordDocument | undefined> => {
  if (name === "draft") return latest;
  if (name === "published")
    return publication.publishedRevision === null
      ? undefined
      : readLive(req, family, latest.id as number);
  const row = (await req.payload.findVersionByID({
    collection: family.slug as "catalogs",
    id: String(name),
    depth: 0,
    overrideAccess: false,
    req,
    user: req.user,
  })) as unknown as { parent: unknown; version: RecordDocument };
  if (row.parent !== latest.id)
    throw new EditorialError("VERSION_NOT_FOUND", 404);
  return { ...row.version, id: latest.id };
};

const textOfSpec = (
  family: CmsFamily,
  doc: RecordDocument | undefined,
  name: string,
) => {
  if (doc === undefined) return undefined;
  const spec = family.fields.find((field) => field.name === name);
  const value = doc[name];
  return spec?.kind === "stateful"
    ? statefulValue(value)
    : typeof value === "string"
      ? value
      : undefined;
};

const diffView = async (
  req: PayloadRequest,
  family: CmsFamily,
  latest: RecordDocument,
  publication: PublicationFacts,
  input: AdminGetInput,
) => {
  if (
    input.fields !== undefined &&
    unknownFields(family, input.fields).length > 0
  )
    return invalidField(family, "fields");
  const fromName = input.from ?? "published";
  const toName = input.to ?? "draft";
  const [from, to] = await Promise.all([
    versionNamed(req, family, latest, publication, fromName),
    versionNamed(req, family, latest, publication, toName),
  ]);
  const common = await recordCommon(
    req,
    family,
    to ?? latest,
    publication,
    "diff",
    typeof toName === "number" ? "version" : toName,
  );
  const changed = changedFieldsBetween(family, from, to ?? {}).filter(
    ({ name }) => input.fields === undefined || input.fields.includes(name),
  );
  return answered(
    {
      ...common,
      // Nothing is live, so no revision or fingerprint can describe what is.
      ...(to === undefined ? { revision: null, fingerprint: null } : {}),
      from: { version: fromName, revision: from?.revision ?? null },
      to: { version: toName, revision: to?.revision ?? null },
      changes: changed.map((spec) => {
        const before = textOfSpec(family, from, spec.name);
        const after = textOfSpec(family, to, spec.name);
        return {
          name: spec.name,
          from: factsOf(spec, from ?? {}),
          to: factsOf(spec, to ?? {}),
          ...(before === undefined || after === undefined
            ? {}
            : { firstDiffOffset: firstDifferenceOffset(before, after) }),
        };
      }),
    },
    // An identity is a `fact`, so it travels by value, and it shows here while nothing
    // is live.
    ["/data/title", "/data/changes/*/from/value", "/data/changes/*/to/value"],
  );
};

const readInto = async (
  req: PayloadRequest,
  family: CmsFamily,
  input: AdminGetInput,
  scope: Scope,
): Promise<AdminMcpEnvelope> => {
  const view = viewOf(input);
  if (!family.versioned && VERSIONED_VIEWS.includes(view))
    return inputInvalidEnvelope([
      {
        path: ["view"],
        code: "view_not_supported",
        allowedKeys: ["outline", "full", "field"],
      },
    ]);
  const id = await rowIdOf(req, family, input.id);
  if (id === undefined) return failedEnvelope("NOT_FOUND");
  const doc = await readLatest(req, family, id);
  const publication = await publicationOf(req, family, doc);
  switch (view) {
    case "outline":
      return outlineView(req, family, doc, publication, input, scope);
    case "full":
      return fullView(req, family, doc, publication, input, scope);
    case "field":
      return fieldView(
        req,
        family,
        doc,
        publication,
        input,
        readFromOf(family),
      );
    case "published":
      return publishedView(req, family, doc, publication, input);
    case "preview":
      return previewView(req, family, doc, publication, scope);
    case "history":
      return historyView(req, family, doc, publication, input);
    case "diff":
      return diffView(req, family, doc, publication, input);
  }
};

export const getEnvelope = async (
  req: PayloadRequest,
  input: AdminGetInput,
  scope: Scope,
): Promise<AdminMcpEnvelope> => {
  if (!isCms(input.type)) return communityGetEnvelope(req, input, scope);
  try {
    const envelope = await readInto(
      req,
      CMS_FAMILIES[input.type],
      input,
      scope,
    );
    // An Article id is on both sides, and a miss in the CMS settles neither.
    return envelope.code === "NOT_FOUND" && isCommunityArticleId(input)
      ? await communityGetEnvelope(req, input, scope)
      : envelope;
  } catch (error) {
    if (
      isMissingRecord(error) ||
      (error instanceof EditorialError && error.code === "VERSION_NOT_FOUND")
    )
      return failedEnvelope("NOT_FOUND");
    throw error;
  }
};

/** A cut answer goes on from the records it kept, by what this view can resume. */
export const getContinuation = (
  rawInput: unknown,
  kept: readonly unknown[],
): AdminMcpNext | undefined => {
  const input = rawInput as AdminGetInput;
  const view = viewOf(input);
  const names = isCms(input.type)
    ? FIELD_NAMES(CMS_FAMILIES[input.type])
    : communityFieldNames(input.type);
  if (kept.length === 0) return undefined;
  const last = kept.at(-1) as Record<string, unknown>;
  if (view === "history")
    return nextOf(input, { cursor: last.versionId as number });
  // Only these two read `find`: on the other views a kept row has no offset.
  if ((view === "field" || view === "published") && input.find !== undefined)
    return nextOf(input, { offset: (last.offset as number) + 1 });
  if (
    view === "full" ||
    view === "outline" ||
    view === "published" ||
    view === "diff"
  ) {
    const reached = new Set(kept.map((row) => (row as { name: string }).name));
    const rest = (input.fields ?? names).filter((name) => !reached.has(name));
    return rest.length === 0 ? undefined : nextOf(input, { fields: rest });
  }
  return undefined;
};
