import { adminUnknownOpDataSchema } from "@moya/contracts/internal/admin-mcp";
import type {
  AdminMcpEnvelope,
  AdminMcpNext,
  AdminReadInput,
} from "@moya/contracts/internal/admin-mcp";

import { controlFor } from "../control/state";
import type { AdminMcpKey } from "../door";
import {
  failedEnvelope,
  inputInvalidEnvelope,
  issuesOfError,
} from "../envelope";
import { NUMBERED_PAGE_SIZE, numberedPageAfter } from "../ops/define";
import {
  adminOpMeta,
  isAdminOpName,
  nearestOps,
  opUnavailable,
} from "../registry";
import type { AdminOpEntry } from "../registry";
import type { PayloadRequest } from "payload";

export const READ_TOOL_NAME = "admin_read";

export const READ_DESCRIPTION = `Read a queue or page by op. Rows are compact; long text is only ever state, length and hash. {op:"list.catalogs",input:{filter:{missing:["transcription"]}}}. {op:"list.reports",input:{status:"open"}}. Count in SQL with no rows: {op:"list.catalogs",view:"count",groupBy:"dynasty",input:{filter:{missing:["transcription"]}}}. {op:"list.reports",view:"count",groupBy:"kind",input:{unresolved:"true"}}. Project with fields:[...], continue with next. admin_actions gives each op's filter.`;

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
  { key, req }: { readonly key: AdminMcpKey; readonly req: PayloadRequest },
): Promise<AdminMcpEnvelope> => {
  const read = rawInput as AdminReadInput;
  if (!isAdminOpName(read.op)) return unknownOpEnvelope(read.op);
  const entry: AdminOpEntry = adminOpMeta[read.op];
  // Class decides the tool: a write named here is not a read of any kind.
  if (entry.tool !== READ_TOOL_NAME) return unknownOpEnvelope(read.op);
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

/** A cut page goes on from the last whole row it kept; a cut count from its offset. */
export const readContinuation = (
  rawInput: unknown,
  kept: readonly unknown[],
): AdminMcpNext | undefined => {
  const read = rawInput as AdminReadInput;
  const last = kept.at(-1) as { id?: unknown; count?: unknown } | undefined;
  if (last === undefined || !isAdminOpName(read.op)) return undefined;
  const entry: AdminOpEntry = adminOpMeta[read.op];
  if (entry.paging === "numbered") {
    // A count's groups are few and closed, and a page number means nothing to them.
    if (read.view === "count") return undefined;
    const { page, pageSize } = entry.input!.parse(read.input ?? {}) as {
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
            pageSize ?? NUMBERED_PAGE_SIZE,
            kept.length,
          ),
        },
      },
    };
  }
  if (entry.paging !== "keyset") return undefined;
  if (read.view === "count")
    return {
      tool: READ_TOOL_NAME,
      args: {
        ...read,
        cursor: String(Number(read.cursor ?? 0) + kept.length),
      },
    };
  return typeof last.id === "number"
    ? { tool: READ_TOOL_NAME, args: { ...read, cursor: String(last.id) } }
    : undefined;
};
