import {
  adminRetiredOpDataSchema,
  adminUnknownOpDataSchema,
  adminWrongToolDataSchema,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminMcpEnvelope,
  AdminMcpNext,
  AdminOpName,
  AdminReadInput,
} from "@moya/contracts/internal/admin-mcp";

import { controlFor } from "../control/state";
import { offsetCursor, offsetOfCursor, rowCursor } from "../cursor";
import type { AdminMcpKey } from "../door";
import {
  failedEnvelope,
  inputInvalidEnvelope,
  issuesOfError,
} from "../envelope";
import { NUMBERED_PAGE_SIZE, numberedPageAfter } from "../ops/define";
import { adminOpMeta, lookupOp, nearestOps, opUnavailable } from "../registry";
import type { AdminOpDeprecation, AdminOpEntry } from "../registry";
import type { PayloadRequest } from "payload";

export const READ_TOOL_NAME = "admin_read";

export const READ_DESCRIPTION = `Read a queue or page by op; long text only as state, length and hash. {op:"list.reports",input:{status:"open"}}. view:"count" with groupBy counts in SQL. Continue with next. admin_actions gives each op's filter.`;

const LIST_SOURCE_ARGS = [
  "cursor",
  "pageSize",
  "view",
  "fields",
  "groupBy",
] as const;

export const unknownOpEnvelope = (name: string): AdminMcpEnvelope =>
  failedEnvelope("UNKNOWN_OP", {
    data: adminUnknownOpDataSchema.parse({ nearest: nearestOps(name) }),
  });

/** An earlier name past its last day: what replaced it, and never a near miss. */
export const retiredOpEnvelope = (retired: {
  readonly op: string;
  readonly use: string;
}): AdminMcpEnvelope =>
  failedEnvelope("OP_RETIRED", {
    data: adminRetiredOpDataSchema.parse(retired),
  });

/** Class decides the tool, so an op named on another one is told where it runs. */
export const wrongToolEnvelope = (tool: string): AdminMcpEnvelope =>
  failedEnvelope("WRONG_TOOL", {
    data: adminWrongToolDataSchema.parse({ tool }),
  });

/** An answer given under earlier names says what to call instead. */
export const withDeprecation = (
  envelope: AdminMcpEnvelope,
  deprecated: readonly AdminOpDeprecation[],
): AdminMcpEnvelope =>
  deprecated.length === 0
    ? envelope
    : {
        ...envelope,
        meta: {
          ...envelope.meta,
          deprecated: deprecated.map((row) => ({ ...row })),
        },
      };

export const opRefusalOf = async (entry: AdminOpEntry, req: PayloadRequest) => {
  const unavailable = opUnavailable(entry, await controlFor(req));
  if (unavailable === undefined) return undefined;
  return failedEnvelope(
    unavailable === "not_available" ? "NOT_AVAILABLE" : unavailable,
  );
};

/** PostgreSQL holds no NUL, so one is named here and never met as a driver error. */
const nulPathOf = (
  value: unknown,
  path: readonly string[],
): string[] | undefined => {
  if (typeof value === "string")
    return value.includes("\u0000") ? [...path] : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  for (const [name, item] of Object.entries(value)) {
    const found = nulPathOf(item, [...path, name]);
    if (found !== undefined) return found;
  }
  return undefined;
};

export const readEnvelope = async (
  rawInput: unknown,
  context: { readonly key: AdminMcpKey; readonly req: PayloadRequest },
): Promise<AdminMcpEnvelope> => {
  const asCalled = rawInput as AdminReadInput;
  const found = lookupOp(asCalled.op);
  if ("unknown" in found) return unknownOpEnvelope(asCalled.op);
  if ("retired" in found) return retiredOpEnvelope(found.retired);
  // Under the registry's name, so every way on an answer gives calls it.
  return withDeprecation(
    await readOp(found.op, { ...asCalled, op: found.op }, context),
    found.deprecated === undefined ? [] : [found.deprecated],
  );
};

const readOp = async (
  name: AdminOpName,
  read: AdminReadInput,
  { key, req }: { readonly key: AdminMcpKey; readonly req: PayloadRequest },
): Promise<AdminMcpEnvelope> => {
  const entry: AdminOpEntry = adminOpMeta[name];
  // Class decides the tool: a write named here is not a read of any kind.
  if (entry.tool !== READ_TOOL_NAME) return wrongToolEnvelope(entry.tool);
  const refusal = await opRefusalOf(entry, req);
  if (refusal !== undefined) return refusal;
  // Only a list source reads these, and quietly dropping one reads as honouring it.
  if (entry.paging !== "keyset") {
    const unread = LIST_SOURCE_ARGS.filter(
      (name) =>
        read[name] !== undefined &&
        read[name] !== "compact" &&
        !(entry.readArgs as readonly string[] | undefined)?.includes(name),
    );
    if (unread.length > 0)
      return inputInvalidEnvelope(
        unread.map((name) => ({ path: [name], code: "not_for_this_op" })),
      );
  }
  const nulPath =
    nulPathOf(read.input, ["input"]) ?? nulPathOf(read.cursor, ["cursor"]);
  if (nulPath !== undefined)
    return inputInvalidEnvelope([{ path: nulPath, code: "nul_character" }]);
  const parsed = entry.input?.safeParse(read.input ?? {}) ?? {
    success: true as const,
    data: read.input ?? {},
  };
  if (!parsed.success)
    return inputInvalidEnvelope(
      issuesOfError(parsed.error, entry.input, ["input"]),
    );
  return entry.run!(parsed.data, { req, key, read });
};

/**
 * A cut page goes on from the last whole row it kept; a cut count from its offset. Rows
 * with no paging of their own answer on the Backend's cursor, which stands past the
 * whole page, so a cut of them has no way on: following it would skip what was cut.
 */
export const readContinuation = (
  rawInput: unknown,
  kept: readonly unknown[],
): AdminMcpNext | null | undefined => {
  const asCalled = rawInput as AdminReadInput;
  const found = lookupOp(asCalled.op);
  const last = kept.at(-1) as { id?: unknown; count?: unknown } | undefined;
  if (last === undefined || !("op" in found)) return undefined;
  // Goes on under the registry's name, whatever the call used.
  const read = { ...asCalled, op: found.op };
  const entry: AdminOpEntry = adminOpMeta[found.op];
  if (entry.paging === undefined && entry.readArgs !== undefined) return null;
  if (entry.paging === "numbered") {
    // A count's groups are few and closed, and a page number means nothing to them.
    if (read.view === "count") return undefined;
    const { page, pageSize = NUMBERED_PAGE_SIZE } = entry.input!.parse(
      read.input ?? {},
    ) as {
      page?: number;
      pageSize?: number;
    };
    return {
      tool: READ_TOOL_NAME,
      args: {
        ...read,
        input: {
          ...read.input,
          ...numberedPageAfter(
            page ?? 1,
            Math.min(pageSize, entry.pageMax ?? pageSize),
            kept.length,
          ),
        },
      },
    };
  }
  if (entry.paging !== "keyset") return undefined;
  if (read.view === "count") {
    // The call this cut answered read its cursor, so it names an offset.
    const offset = read.cursor === undefined ? 0 : offsetOfCursor(read.cursor);
    return offset === undefined
      ? undefined
      : {
          tool: READ_TOOL_NAME,
          args: { ...read, cursor: offsetCursor(offset + kept.length) },
        };
  }
  return typeof last.id === "number"
    ? { tool: READ_TOOL_NAME, args: { ...read, cursor: rowCursor(last.id) } }
    : undefined;
};
