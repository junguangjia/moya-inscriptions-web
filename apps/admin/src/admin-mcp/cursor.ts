/**
 * admin_read's cursors (admin-mcp-completion-v1 S8): a version prefix and a base64url
 * JSON payload, so a cursor a client still holds is never read under another format.
 * `k1:` goes on from a row's keyset, `o1:` from an offset. Contracts are shared with
 * the website, which has no Buffer, so the format lives here.
 */

export const ADMIN_CURSOR_PREFIXES = { keyset: "k1:", offset: "o1:" } as const;
export type AdminCursorKind = keyof typeof ADMIN_CURSOR_PREFIXES;

/**
 * A bare cursor, the form before the prefix, is still read through this UTC day: at
 * least 30 days and one Production release past the release that adds the prefix, the
 * longer, as an op alias is kept. A cursor is always written with its prefix.
 */
export const ADMIN_CURSOR_LEGACY_UNTIL = "2027-01-31";

/** A row id is an int4: past this the column cannot compare, and no `next` says it. */
export const ROW_ID_MAX = 2_147_483_647;
const OFFSET_MAX = 999_999_999;
const LEGACY_ROW_ID = /^[1-9]\d{0,15}$/u;
const LEGACY_OFFSET = /^\d{1,9}$/u;
/** The shape of any version prefix, known or not. */
const PREFIXED = /^[a-z]\d+:/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export const encodeCursor = (
  kind: AdminCursorKind,
  payload: Readonly<Record<string, unknown>>,
): string =>
  `${ADMIN_CURSOR_PREFIXES[kind]}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;

export type DecodedCursor =
  | { readonly payload: Readonly<Record<string, unknown>> }
  | { readonly bare: string };

/**
 * What a cursor of this kind holds, or undefined: another prefix or version, a payload
 * that is not a JSON object in canonical base64url, or a bare cursor past its last day.
 */
export const decodeCursor = (
  cursor: string,
  kind: AdminCursorKind,
  now: Date = new Date(),
): DecodedCursor | undefined => {
  if (!PREFIXED.test(cursor))
    return now.toISOString().slice(0, 10) <= ADMIN_CURSOR_LEGACY_UNTIL
      ? { bare: cursor }
      : undefined;
  const prefix = ADMIN_CURSOR_PREFIXES[kind];
  if (!cursor.startsWith(prefix)) return undefined;
  const body = cursor.slice(prefix.length);
  if (!BASE64URL.test(body)) return undefined;
  const text = Buffer.from(body, "base64url").toString("utf8");
  // One spelling per payload, so two cursors never name one place differently.
  if (Buffer.from(text, "utf8").toString("base64url") !== body)
    return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
    ? { payload: payload as Record<string, unknown> }
    : undefined;
};

/** The one integer a payload holds under `name`, within its bounds. */
const onlyInteger = (
  payload: Readonly<Record<string, unknown>>,
  name: string,
  min: number,
  max: number,
): number | undefined => {
  const value = payload[name];
  return Object.keys(payload).length === 1 &&
    Number.isSafeInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
    ? (value as number)
    : undefined;
};

export const rowCursor = (id: number): string => encodeCursor("keyset", { id });

/** The row id a page goes on below, or undefined if the cursor names none. */
export const rowIdOfCursor = (
  cursor: string,
  now?: Date,
): number | undefined => {
  const decoded = decodeCursor(cursor, "keyset", now);
  if (decoded === undefined) return undefined;
  if ("payload" in decoded)
    return onlyInteger(decoded.payload, "id", 1, ROW_ID_MAX);
  return LEGACY_ROW_ID.test(decoded.bare) && Number(decoded.bare) <= ROW_ID_MAX
    ? Number(decoded.bare)
    : undefined;
};

/** A run's place in list.runs: its creation, to the microsecond PostgreSQL keeps, and its id. */
export interface RunKeyset {
  readonly at: string;
  readonly id: string;
}

const MICROSECOND_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const RUN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const runCursor = ({ at, id }: RunKeyset): string =>
  encodeCursor("keyset", { at, id });

/** The run a page goes on after, or undefined: a bare cursor never named a run. */
export const runKeysetOfCursor = (
  cursor: string,
  now?: Date,
): RunKeyset | undefined => {
  const decoded = decodeCursor(cursor, "keyset", now);
  if (decoded === undefined || !("payload" in decoded)) return undefined;
  const { at, id, ...rest } = decoded.payload;
  return Object.keys(rest).length === 0 &&
    typeof at === "string" &&
    MICROSECOND_TIME.test(at) &&
    typeof id === "string" &&
    RUN_ID.test(id)
    ? { at, id }
    : undefined;
};

export const indexCursor = (index: number): string =>
  encodeCursor("keyset", { index });

/** The target index a run's page goes on after, or undefined. */
export const indexOfCursor = (
  cursor: string,
  now?: Date,
): number | undefined => {
  const decoded = decodeCursor(cursor, "keyset", now);
  return decoded === undefined || !("payload" in decoded)
    ? undefined
    : onlyInteger(decoded.payload, "index", 0, ROW_ID_MAX);
};

export const offsetCursor = (offset: number): string =>
  encodeCursor("offset", { offset });

/** The offset a count's groups go on from, or undefined if the cursor names none. */
export const offsetOfCursor = (
  cursor: string,
  now?: Date,
): number | undefined => {
  const decoded = decodeCursor(cursor, "offset", now);
  if (decoded === undefined) return undefined;
  if ("payload" in decoded)
    return onlyInteger(decoded.payload, "offset", 0, OFFSET_MAX);
  return LEGACY_OFFSET.test(decoded.bare) ? Number(decoded.bare) : undefined;
};
