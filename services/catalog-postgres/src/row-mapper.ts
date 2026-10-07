import {
  catalogIdSchema,
  catalogKindSchema,
  mediaIdSchema,
} from "@moya/contracts/schemas";

import type {
  CatalogContributorProjection,
  CatalogDetailProjection,
  CatalogFieldState,
  CatalogListItemProjection,
  CatalogMediaProjection,
  CatalogSourceCitationProjection,
  CatalogStatefulTextProjection,
} from "@moya/api";
import { deriveCatalogPeriodLabel } from "@moya/api";
import { mapCatalogMediaDelivery } from "./catalog-media-delivery.js";
import type {
  CatalogCitationScope,
  CatalogContributorRole,
} from "@moya/contracts";
import type { QueryResultRow } from "pg";

export interface CatalogEntryRow extends QueryResultRow {
  readonly catalog_id: unknown;
  readonly kind: unknown;
  readonly title: unknown;
  readonly summary: unknown;
  readonly description?: unknown;
  readonly period_label: unknown;
  readonly dynasty: unknown;
  readonly dynasty_state: unknown;
  readonly date_text: unknown;
  readonly date_text_state: unknown;
  readonly province: unknown;
  readonly province_state: unknown;
  readonly prefecture: unknown;
  readonly prefecture_state: unknown;
  readonly county: unknown;
  readonly county_state: unknown;
  readonly current_location: unknown;
  readonly current_location_state: unknown;
  readonly current_custodian: unknown;
  readonly current_custodian_state: unknown;
  readonly script_style?: unknown;
  readonly script_style_state?: unknown;
  readonly transcription?: unknown;
  readonly transcription_state?: unknown;
  readonly historical_context?: unknown;
  readonly historical_context_state?: unknown;
  readonly scholarly_research?: unknown;
  readonly scholarly_research_state?: unknown;
}

export interface CatalogAliasRow extends QueryResultRow {
  readonly catalog_id: unknown;
  readonly position: unknown;
  readonly alias: unknown;
}

export interface CatalogCitationRow extends QueryResultRow {
  readonly catalog_id: unknown;
  readonly position: unknown;
  readonly label: unknown;
  readonly citation: unknown;
  readonly url: unknown;
}

export interface CatalogContributorRow extends QueryResultRow {
  readonly catalog_id: unknown;
  readonly position: unknown;
  readonly name: unknown;
  readonly role: unknown;
}

export interface CatalogCitationScopeRow extends QueryResultRow {
  readonly catalog_id: unknown;
  readonly citation_position: unknown;
  readonly scope: unknown;
}

export interface CatalogMediaRow extends QueryResultRow {
  readonly media_id: unknown;
  readonly catalog_id: unknown;
  readonly position: unknown;
  readonly is_representative: unknown;
  readonly kind: unknown;
  readonly alt_text: unknown;
  readonly width: unknown;
  readonly height: unknown;
  readonly object_key: unknown;
  /** Joined rendition delivery facts; absent unless the reader joins them. */
  readonly renditions?: unknown;
  readonly placeholder_color?: unknown;
}

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string") {
    throw new Error(`Invalid PostgreSQL Catalog ${field}`);
  }
  return value;
};

const requiredExactText = (
  value: unknown,
  field: string,
  maximum: number,
): string => {
  const text = requiredString(value, field);
  if (text.length === 0 || text.trim() !== text || text.length > maximum) {
    throw new Error(`Invalid PostgreSQL Catalog ${field}`);
  }
  return text;
};

const optionalString = (value: unknown, field: string): string | undefined =>
  value === null ? undefined : requiredString(value, field);

const catalogFieldStates = new Set<CatalogFieldState>([
  "VALUE",
  "UNSUPPLIED",
  "UNKNOWN",
  "NOT_APPLICABLE",
  "CLEAR",
]);

const catalogLongContentStates = new Set<CatalogFieldState>([
  "VALUE",
  "UNSUPPLIED",
  "CLEAR",
]);

const readCatalogFieldState = (
  value: unknown,
  field: string,
): CatalogFieldState => {
  if (
    typeof value !== "string" ||
    !catalogFieldStates.has(value as CatalogFieldState)
  ) {
    throw new Error(`Invalid PostgreSQL Catalog ${field}`);
  }
  return value as CatalogFieldState;
};

const readStatefulTextProjection = (
  row: CatalogEntryRow,
  valueField: keyof CatalogEntryRow,
  stateField: keyof CatalogEntryRow,
  field: string,
): CatalogStatefulTextProjection => {
  const state = readCatalogFieldState(row[stateField], `${field} state`);
  if (state === "VALUE") {
    return {
      state,
      value: requiredString(row[valueField], field),
    };
  }
  if (row[valueField] !== null && row[valueField] !== undefined) {
    throw new Error(`Invalid PostgreSQL Catalog ${field} state mismatch`);
  }
  return { state };
};

const readContentTextProjection = (
  row: CatalogEntryRow,
  valueField: keyof CatalogEntryRow,
  stateField: keyof CatalogEntryRow,
  field: string,
  maximum: number,
  allowedStates: ReadonlySet<CatalogFieldState>,
): CatalogStatefulTextProjection => {
  const state = readCatalogFieldState(row[stateField], `${field} state`);
  if (!allowedStates.has(state)) {
    throw new Error(`Invalid PostgreSQL Catalog ${field} state`);
  }
  if (state === "VALUE") {
    return {
      state,
      value: requiredExactText(row[valueField], field, maximum),
    };
  }
  if (row[valueField] !== null) {
    throw new Error(`Invalid PostgreSQL Catalog ${field} state mismatch`);
  }
  return { state };
};

const storedPeriodLabelProjection = (
  row: CatalogEntryRow,
): { readonly storedPeriodLabel: string } | Record<string, never> => {
  const storedPeriodLabel = optionalString(row.period_label, "period label");
  return storedPeriodLabel === undefined ? {} : { storedPeriodLabel };
};

const positiveInteger = (value: unknown, field: string): number => {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`Invalid PostgreSQL Catalog Media ${field}`);
  }
  return Number(value);
};

export const mapCatalogMediaRow = (
  row: CatalogMediaRow,
): CatalogMediaProjection => {
  if (!Number.isInteger(row.position) || Number(row.position) < 0) {
    throw new Error("Invalid PostgreSQL Catalog Media position");
  }
  if (typeof row.is_representative !== "boolean") {
    throw new Error("Invalid PostgreSQL Catalog Media representative flag");
  }
  if (row.kind !== "image") {
    throw new Error("Invalid PostgreSQL Catalog Media kind");
  }

  return {
    id: mediaIdSchema.parse(row.media_id),
    position: Number(row.position),
    isRepresentative: row.is_representative,
    kind: row.kind,
    alt: requiredString(row.alt_text, "Media alt text"),
    width: positiveInteger(row.width, "width"),
    height: positiveInteger(row.height, "height"),
    objectKey: requiredString(row.object_key, "Media object key"),
    ...mapCatalogMediaDelivery(row.renditions, row.placeholder_color),
  };
};

export const mapCatalogEntryRow = (
  row: CatalogEntryRow,
  aliases: readonly string[],
  representativeMedia?: CatalogMediaProjection,
): CatalogListItemProjection => {
  const periodLabel = deriveCatalogPeriodLabel({
    dynasty: readStatefulTextProjection(
      row,
      "dynasty",
      "dynasty_state",
      "dynasty",
    ),
    dateText: readStatefulTextProjection(
      row,
      "date_text",
      "date_text_state",
      "date text",
    ),
    ...storedPeriodLabelProjection(row),
  });

  return {
    id: catalogIdSchema.parse(row.catalog_id),
    kind: catalogKindSchema.parse(row.kind),
    title: requiredString(row.title, "title"),
    aliases: [...aliases],
    ...(row.summary === null
      ? {}
      : { summary: requiredString(row.summary, "summary") }),
    ...(periodLabel === undefined ? {} : { periodLabel }),
    province: readStatefulTextProjection(
      row,
      "province",
      "province_state",
      "province",
    ),
    ...(representativeMedia === undefined
      ? {}
      : { representativeMedia: { ...representativeMedia } }),
  };
};

const contributorRoles = new Set<CatalogContributorRole>([
  "textAuthor",
  "calligrapher",
]);

const mapContributorRows = (
  rows: readonly CatalogContributorRow[],
): readonly CatalogContributorProjection[] => {
  if (rows.length > 50) {
    throw new Error("Invalid PostgreSQL Catalog contributor count");
  }

  const contributors: CatalogContributorProjection[] = [];
  const identities = new Set<string>();
  let catalogId: string | undefined;
  let previousPosition = -1;

  for (const row of rows) {
    const rowCatalogId = requiredString(
      row.catalog_id,
      "contributor catalog ID",
    );
    if (catalogId !== undefined && rowCatalogId !== catalogId) {
      throw new Error("Invalid PostgreSQL Catalog contributor catalog ID");
    }
    catalogId = rowCatalogId;

    if (!Number.isInteger(row.position) || Number(row.position) < 0) {
      throw new Error("Invalid PostgreSQL Catalog contributor position");
    }
    const position = Number(row.position);
    if (position <= previousPosition) {
      throw new Error("Invalid PostgreSQL Catalog contributor order");
    }
    previousPosition = position;

    const name = requiredExactText(row.name, "contributor name", 500);
    if (
      typeof row.role !== "string" ||
      !contributorRoles.has(row.role as CatalogContributorRole)
    ) {
      throw new Error("Invalid PostgreSQL Catalog contributor role");
    }
    const role = row.role as CatalogContributorRole;
    const identity = JSON.stringify([name, role]);
    if (identities.has(identity)) {
      throw new Error("Invalid PostgreSQL Catalog contributor identity");
    }
    identities.add(identity);
    contributors.push({ name, role });
  }

  return contributors;
};

export const mapCatalogDetailRow = (
  row: CatalogEntryRow,
  aliases: readonly string[],
  sourceCitations: readonly CatalogSourceCitationProjection[],
  media: readonly CatalogMediaProjection[] = [],
  contributorRows: readonly CatalogContributorRow[] = [],
): CatalogDetailProjection => {
  const contributors = mapContributorRows(contributorRows);

  return {
    ...mapCatalogEntryRow(
      row,
      aliases,
      media.find(({ isRepresentative }) => isRepresentative),
    ),
    dynasty: readStatefulTextProjection(
      row,
      "dynasty",
      "dynasty_state",
      "dynasty",
    ),
    dateText: readStatefulTextProjection(
      row,
      "date_text",
      "date_text_state",
      "date text",
    ),
    province: readStatefulTextProjection(
      row,
      "province",
      "province_state",
      "province",
    ),
    prefecture: readStatefulTextProjection(
      row,
      "prefecture",
      "prefecture_state",
      "prefecture",
    ),
    county: readStatefulTextProjection(row, "county", "county_state", "county"),
    currentLocation: readStatefulTextProjection(
      row,
      "current_location",
      "current_location_state",
      "current location",
    ),
    currentCustodian: readStatefulTextProjection(
      row,
      "current_custodian",
      "current_custodian_state",
      "current custodian",
    ),
    scriptStyle: readContentTextProjection(
      row,
      "script_style",
      "script_style_state",
      "script style",
      2_000,
      catalogFieldStates,
    ),
    transcription: readContentTextProjection(
      row,
      "transcription",
      "transcription_state",
      "transcription",
      100_000,
      catalogLongContentStates,
    ),
    historicalContext: readContentTextProjection(
      row,
      "historical_context",
      "historical_context_state",
      "historical context",
      20_000,
      catalogLongContentStates,
    ),
    scholarlyResearch: readContentTextProjection(
      row,
      "scholarly_research",
      "scholarly_research_state",
      "scholarly research",
      20_000,
      catalogLongContentStates,
    ),
    ...(contributors.length === 0 ? {} : { contributors }),
    sourceCitations: sourceCitations.map((citation) => ({
      ...citation,
      ...(citation.appliesTo === undefined
        ? {}
        : { appliesTo: [...citation.appliesTo] }),
    })),
    media: media.map((item) => ({ ...item })),
    ...(row.description === null || row.description === undefined
      ? {}
      : { description: requiredString(row.description, "description") }),
  };
};

export const mapAliasRows = (
  rows: readonly CatalogAliasRow[],
): ReadonlyMap<string, readonly string[]> => {
  const aliases = new Map<string, string[]>();
  for (const row of rows) {
    const catalogId = requiredString(row.catalog_id, "alias catalog ID");
    const alias = requiredString(row.alias, "alias");
    if (!Number.isInteger(row.position) || Number(row.position) < 0) {
      throw new Error("Invalid PostgreSQL Catalog alias position");
    }
    const values = aliases.get(catalogId) ?? [];
    values.push(alias);
    aliases.set(catalogId, values);
  }
  return aliases;
};

const catalogCitationScopes = new Set<CatalogCitationScope>([
  "record",
  "description",
  "transcription",
  "historicalContext",
  "scholarlyResearch",
]);

const citationScopeOrder = new Map<CatalogCitationScope, number>([
  ["record", 1],
  ["description", 2],
  ["transcription", 3],
  ["historicalContext", 4],
  ["scholarlyResearch", 5],
]);

const mapCitationScopeRows = (
  rows: readonly CatalogCitationScopeRow[],
): ReadonlyMap<number, readonly CatalogCitationScope[]> => {
  const scopesByCitation = new Map<number, CatalogCitationScope[]>();
  const previousScopeOrder = new Map<number, number>();
  let catalogId: string | undefined;

  for (const row of rows) {
    const rowCatalogId = requiredString(
      row.catalog_id,
      "citation scope catalog ID",
    );
    if (catalogId !== undefined && rowCatalogId !== catalogId) {
      throw new Error("Invalid PostgreSQL Catalog citation scope catalog ID");
    }
    catalogId = rowCatalogId;

    if (
      !Number.isInteger(row.citation_position) ||
      Number(row.citation_position) < 0
    ) {
      throw new Error("Invalid PostgreSQL Catalog citation scope position");
    }
    if (
      typeof row.scope !== "string" ||
      !catalogCitationScopes.has(row.scope as CatalogCitationScope)
    ) {
      throw new Error("Invalid PostgreSQL Catalog citation scope");
    }

    const position = Number(row.citation_position);
    const scope = row.scope as CatalogCitationScope;
    const scopeOrder = citationScopeOrder.get(scope);
    if (scopeOrder === undefined) {
      throw new Error("Invalid PostgreSQL Catalog citation scope");
    }
    const previousOrder = previousScopeOrder.get(position) ?? 0;
    if (scopeOrder <= previousOrder) {
      throw new Error("Invalid PostgreSQL Catalog citation scope order");
    }
    previousScopeOrder.set(position, scopeOrder);

    const scopes = scopesByCitation.get(position) ?? [];
    if (scopes.includes(scope)) {
      throw new Error("Invalid PostgreSQL Catalog duplicate citation scope");
    }
    scopes.push(scope);
    scopesByCitation.set(position, scopes);
  }

  return scopesByCitation;
};

export const mapCitationRows = (
  rows: readonly CatalogCitationRow[],
  scopeRows: readonly CatalogCitationScopeRow[] = [],
): readonly CatalogSourceCitationProjection[] => {
  const citationScopes = mapCitationScopeRows(scopeRows);
  const matchedScopePositions = new Set<number>();
  const citationPositions = new Set<number>();

  const citations = rows.map((row) => {
    if (!Number.isInteger(row.position) || Number(row.position) < 0) {
      throw new Error("Invalid PostgreSQL Catalog citation position");
    }
    const position = Number(row.position);
    if (citationPositions.has(position)) {
      throw new Error("Invalid PostgreSQL Catalog citation position");
    }
    citationPositions.add(position);

    const citation = optionalString(row.citation, "citation");
    const url = optionalString(row.url, "citation URL");
    const appliesTo = citationScopes.get(position);
    if (appliesTo !== undefined) {
      matchedScopePositions.add(position);
    }
    return {
      label: requiredString(row.label, "citation label"),
      ...(citation === undefined ? {} : { citation }),
      ...(url === undefined ? {} : { url }),
      ...(appliesTo === undefined ? {} : { appliesTo: [...appliesTo] }),
    };
  });

  if (matchedScopePositions.size !== citationScopes.size) {
    throw new Error("Invalid PostgreSQL Catalog orphan citation scope");
  }

  return citations;
};

export const mapRepresentativeMediaRows = (
  rows: readonly CatalogMediaRow[],
): ReadonlyMap<string, CatalogMediaProjection> => {
  const representativeMedia = new Map<string, CatalogMediaProjection>();
  for (const row of rows) {
    const catalogId = requiredString(row.catalog_id, "Media catalog ID");
    if (representativeMedia.has(catalogId)) {
      throw new Error(
        "Invalid PostgreSQL Catalog Media representative multiplicity",
      );
    }
    const media = mapCatalogMediaRow(row);
    if (!media.isRepresentative) {
      throw new Error("Invalid PostgreSQL representative Media row");
    }
    representativeMedia.set(catalogId, media);
  }
  return representativeMedia;
};

export const mapCatalogMediaRows = (
  rows: readonly CatalogMediaRow[],
): readonly CatalogMediaProjection[] => rows.map(mapCatalogMediaRow);
