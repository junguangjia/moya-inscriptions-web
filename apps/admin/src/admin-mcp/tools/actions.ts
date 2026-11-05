import {
  ADMIN_ACTIONS_MAX_OPS,
  ADMIN_MCP_TEXT_CAP_BYTES,
  ADMIN_OP_NAMES,
  ADMIN_OP_TOOLS,
  adminActionDetailsSchema,
  adminActionsIndexSchema,
  adminUnknownOpDataSchema,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminActionDetail,
  AdminActionsIndex,
  AdminActionsInput,
  AdminMcpEnvelope,
  AdminMcpNext,
  AdminMcpSensitiveCategory,
  AdminOpName,
} from "@moya/contracts/internal/admin-mcp";
import { z } from "zod";

import { failedEnvelope, inputInvalidEnvelope, okEnvelope } from "../envelope";
import {
  adminOpMeta,
  isAdminOpName,
  nearestOps,
  opUnavailable,
} from "../registry";
import type { AdminOpEntry } from "../registry";

export const ACTIONS_TOOL_NAME = "admin_actions";

export const ACTIONS_DESCRIPTION = `Op catalog for admin_read and the execute tools. No arguments: an index by tool, rows as name(required,fields). {ops:[up to ${ADMIN_ACTIONS_MAX_OPS} names]}: each op's JSON Schema, class, recovery, completion and an example. Inputs refuse unknown fields.`;

export type ActionSwitches = Readonly<
  Partial<Record<AdminMcpSensitiveCategory, boolean>>
>;

const entryOf = (name: AdminOpName): AdminOpEntry => adminOpMeta[name];

/**
 * Noise a client does not act on, removed so a detail fits one text result: Zod's
 * safe-integer bounds, the format's own pattern, the draft name, and `strict`, which
 * the tool description states once for all.
 */
const compact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(compact);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (key === "$schema" || key === "propertyNames") continue;
    if (key === "additionalProperties" && item === false) continue;
    if (key === "pattern" && typeof source.format === "string") continue;
    if (
      (key === "maximum" || key === "minimum") &&
      Math.abs(item as number) === Number.MAX_SAFE_INTEGER
    )
      continue;
    kept[key] = key === "properties" ? compactProperties(item) : compact(item);
  }
  return kept;
};

const compactProperties = (value: unknown): unknown =>
  Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, schema]) => [
      name,
      compact(schema),
    ]),
  );

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

// Inline reads best. Past this, repeated parts move to $defs, so the long Catalog
// draft still fits one text result.
const INLINE_SCHEMA_BYTES = 4_000;

const schemaOf = (schema: z.ZodType, io: "input" | "output") => {
  const built = (reused: "inline" | "ref") =>
    compact(
      z.toJSONSchema(schema, {
        target: "draft-2020-12",
        io,
        unrepresentable: "any",
        reused,
      }),
    ) as Record<string, unknown>;
  const inline = built("inline");
  return bytesOf(inline) <= INLINE_SCHEMA_BYTES ? inline : built("ref");
};

/** Fields required on every branch, so a union's row still names what it needs. */
const requiredOf = (schema: Record<string, unknown>): readonly string[] => {
  if (Array.isArray(schema.required)) return schema.required as string[];
  const branches = (schema.anyOf ?? schema.oneOf) as
    Record<string, unknown>[] | undefined;
  if (branches === undefined) return [];
  const [first, ...rest] = branches.map(requiredOf);
  return (first ?? []).filter((name) =>
    rest.every((other) => other.includes(name)),
  );
};

/** Built once per process, like the tool list. */
const inputSchemas = new Map<AdminOpName, Record<string, unknown>>();
const inputSchemaOf = (name: AdminOpName) => {
  const { input } = entryOf(name);
  if (input === undefined) return undefined;
  const known = inputSchemas.get(name);
  if (known !== undefined) return known;
  const built = schemaOf(input, "input");
  inputSchemas.set(name, built);
  return built;
};

const rowOf = (name: AdminOpName): string => {
  const schema = inputSchemaOf(name);
  const required = schema === undefined ? [] : requiredOf(schema);
  return required.length === 0 ? name : `${name}(${required.join(",")})`;
};

/** The index a key sees: only the tools it can call now, in listing order. */
export const actionsIndex = (
  tools: readonly string[],
  switches: ActionSwitches,
): AdminActionsIndex => {
  const groups = ADMIN_OP_TOOLS.filter((tool) => tools.includes(tool)).map(
    (tool) => {
      const names = ADMIN_OP_NAMES.filter(
        (name) => entryOf(name).tool === tool,
      );
      const ops: string[] = [];
      const unavailable: Record<string, string[]> = {};
      for (const name of names) {
        const code = opUnavailable(entryOf(name), switches);
        if (code === undefined) ops.push(rowOf(name));
        else (unavailable[code] ??= []).push(rowOf(name));
      }
      return {
        tool,
        class: entryOf(names[0]!).klass,
        ops,
        ...(Object.keys(unavailable).length > 0 ? { unavailable } : {}),
      };
    },
  );
  return adminActionsIndexSchema.parse({
    count: groups.reduce((sum, { ops }) => sum + ops.length, 0),
    groups,
  });
};

// A detail alone must fit a text result with room for the envelope around it.
const DETAIL_CAP_BYTES = ADMIN_MCP_TEXT_CAP_BYTES - 500;

export const actionDetail = (
  name: AdminOpName,
  tools: readonly string[],
  switches: ActionSwitches,
): AdminActionDetail => {
  const entry = entryOf(name);
  const output = entry.output?.ai ?? entry.output?.owner;
  const input = inputSchemaOf(name);
  const unavailable = tools.includes(entry.tool)
    ? opUnavailable(entry, switches)
    : "tool_not_listed";
  const detail: AdminActionDetail = {
    op: name,
    summary: entry.summary,
    tool: entry.tool,
    class: entry.klass,
    ...(entry.risesWhen ? { risesWhen: entry.risesWhen } : {}),
    ...(entry.sensitive ? { sensitive: entry.sensitive } : {}),
    recovery: entry.recovery,
    completion: entry.completion.kind,
    available: unavailable === undefined,
    ...(unavailable === undefined ? {} : { unavailable }),
    ...(input === undefined ? {} : { input }),
    ...(entry.example === undefined ? {} : { example: { ...entry.example } }),
    ...(entry.selectorSources === undefined
      ? {}
      : { selectorSources: [...entry.selectorSources] }),
  };
  if (output === undefined) return detail;
  const withOutput = { ...detail, output: schemaOf(output, "output") };
  return bytesOf(withOutput) <= DETAIL_CAP_BYTES
    ? withOutput
    : { ...detail, outputOmitted: true };
};

const askedNames = (rawInput: unknown): readonly string[] => {
  const { op, ops } = rawInput as AdminActionsInput;
  return [...new Set([...(op === undefined ? [] : [op]), ...(ops ?? [])])];
};

export const actionsEnvelope = (
  rawInput: unknown,
  tools: readonly string[],
  switches: ActionSwitches,
): AdminMcpEnvelope => {
  const names = askedNames(rawInput);
  if (names.length === 0) return okEnvelope(actionsIndex(tools, switches));
  if (names.length > ADMIN_ACTIONS_MAX_OPS)
    return inputInvalidEnvelope([{ path: ["ops"], code: "too_big" }]);
  const unknown = names.find((name) => !isAdminOpName(name));
  if (unknown !== undefined)
    return failedEnvelope("UNKNOWN_OP", {
      data: adminUnknownOpDataSchema.parse({ nearest: nearestOps(unknown) }),
    });
  return okEnvelope(
    adminActionDetailsSchema.parse({
      details: (names as AdminOpName[]).map((name) =>
        actionDetail(name, tools, switches),
      ),
    }),
  );
};

/** A cut detail call continues with the names it did not reach. */
export const actionsContinuation = (
  rawInput: unknown,
  kept: readonly unknown[],
): AdminMcpNext | undefined => {
  const reached = new Set(kept.map((detail) => (detail as { op: string }).op));
  const rest = askedNames(rawInput).filter((name) => !reached.has(name));
  return rest.length === 0
    ? undefined
    : { tool: ACTIONS_TOOL_NAME, args: { ops: rest } };
};
