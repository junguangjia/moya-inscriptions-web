import {
  adminReadInputSchema,
  adminUnknownOpDataSchema,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminMcpEnvelope,
  AdminMcpNext,
  AdminOpName,
  AdminReadInput,
} from "@moya/contracts/internal/admin-mcp";
import { z } from "zod";

import { controlFor } from "../control/state";
import type { AdminMcpKey } from "../door";
import {
  failedEnvelope,
  inputInvalidEnvelope,
  issuesOfError,
} from "../envelope";
import {
  adminOpMeta,
  isAdminOpName,
  nearestOps,
  opsOnTool,
  opUnavailable,
} from "../registry";
import type { AdminOpEntry } from "../registry";
import type { PayloadRequest } from "payload";

export const READ_TOOL_NAME = "admin_read";

export const READ_DESCRIPTION = `Read a queue or page by op. Rows are compact; long text is only ever state, length and hash. {op:"list.catalogs",input:{filter:{missing:["transcription"]}}}. Count in SQL with no rows: {op:"list.catalogs",view:"count",groupBy:"dynasty",input:{filter:{missing:["transcription"]}}}. Project with fields:[...], continue with next. admin_actions gives each op's filter.`;

/** The names a client sees. At runtime a wrong name answers UNKNOWN_OP with near ones. */
export const readListedInput = adminReadInputSchema.extend({
  op: z.enum(opsOnTool("admin_read") as [AdminOpName, ...AdminOpName[]]),
});

const LIST_SOURCE_ARGS = [
  "cursor",
  "pageSize",
  "view",
  "fields",
  "groupBy",
] as const;

const unknownOp = (name: string): AdminMcpEnvelope =>
  failedEnvelope("UNKNOWN_OP", {
    data: adminUnknownOpDataSchema.parse({ nearest: nearestOps(name) }),
  });

const refusalOf = async (entry: AdminOpEntry, req: PayloadRequest) => {
  const unavailable = opUnavailable(entry, await controlFor(req));
  if (unavailable === undefined) return undefined;
  return failedEnvelope(
    unavailable === "not_available" ? "NOT_AVAILABLE" : unavailable,
  );
};

export const readEnvelope = async (
  rawInput: unknown,
  { key, req }: { readonly key: AdminMcpKey; readonly req: PayloadRequest },
): Promise<AdminMcpEnvelope> => {
  const read = rawInput as AdminReadInput;
  if (!isAdminOpName(read.op)) return unknownOp(read.op);
  const entry: AdminOpEntry = adminOpMeta[read.op];
  // Class decides the tool: a write named here is not a read of any kind.
  if (entry.tool !== READ_TOOL_NAME) return unknownOp(read.op);
  const refusal = await refusalOf(entry, req);
  if (refusal !== undefined) return refusal;
  // Only a list source reads these, and quietly dropping one reads as honouring it.
  if (entry.paging !== "keyset") {
    const unread = LIST_SOURCE_ARGS.filter(
      (name) => read[name] !== undefined && read[name] !== "compact",
    );
    if (unread.length > 0)
      return inputInvalidEnvelope(
        unread.map((name) => ({ path: [name], code: "not_for_this_op" })),
      );
  }
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

/** The largest page size that starts a page right after the rows kept. */
const numberedPageAfter = (page: number, pageSize: number, kept: number) => {
  const offset = (page - 1) * pageSize + kept;
  let size = kept;
  while (offset % size !== 0) size -= 1;
  return { page: offset / size + 1, pageSize: size };
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
    const { page, pageSize } = entry.input!.parse(read.input ?? {}) as {
      page: number;
      pageSize: number;
    };
    return {
      tool: READ_TOOL_NAME,
      args: {
        ...read,
        input: {
          ...read.input,
          ...numberedPageAfter(page, pageSize, kept.length),
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
