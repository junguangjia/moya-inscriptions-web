import { randomUUID } from "node:crypto";

import type { MCPPluginConfig } from "@payloadcms/plugin-mcp";
import type { PayloadRequest } from "payload";

import type { McpAuditEvent } from "../payload-types";
import { writeAuditEvent } from "./audit";
import { controlFor } from "./control/state";
import { admittedKeyOf, takeRequestStart } from "./door";
import { failedEnvelope } from "./envelope";
import { WHOAMI_TOOL_NAME } from "./tools/whoami";

type PluginTool = NonNullable<
  NonNullable<MCPPluginConfig["mcp"]>["tools"]
>[number];

export type AdminMcpGuardRefusal = "AUDIT_UNAVAILABLE" | "MCP_PAUSED";

export interface GuardCall {
  readonly req: PayloadRequest;
  readonly tool: string;
  readonly klass: McpAuditEvent["class"];
  readonly targetType?: string;
  readonly targetId?: string;
  readonly requestId?: string;
}

export interface GuardOutcome {
  readonly ok: boolean;
  readonly code: string;
  readonly responseBytes?: number;
  /** For a call that names its target only in its answer, such as a create. */
  readonly targetType?: string;
  readonly targetId?: string;
}

/**
 * Section 4 of docs/development/admin-mcp-completion-v1.md, on both paths. A write
 * records its start before anything runs, on a connection of its own, and a failed
 * start refuses it. A read records only its finish, and a read it could not record
 * delivers nothing. A write that already ran still answers truthfully: its start
 * with no finish reads as outcome unknown.
 */
export const guardCall = async <T>(
  { req, tool, klass, ...references }: GuardCall,
  execute: () => Promise<T>,
  outcomeOf: (value: T) => GuardOutcome,
): Promise<
  { readonly refused: AdminMcpGuardRefusal } | { readonly value: T }
> => {
  const key = admittedKeyOf(req);
  const started = takeRequestStart(req);
  const call = {
    callId: randomUUID(),
    class: klass,
    tool,
    ...references,
    ...(key
      ? { keyId: key.id, ...(key.label ? { keyLabel: key.label } : {}) }
      : {}),
    ...(req.user ? { userId: String(req.user.id) } : {}),
  };
  const finish = ({ responseBytes, ...outcome }: GuardOutcome) =>
    writeAuditEvent(req.payload, {
      ...outcome,
      ...call,
      phase: "finish",
      durationMs: Math.round(performance.now() - started),
      ...(responseBytes === undefined ? {} : { responseBytes }),
    });
  const logFailedWrite = () =>
    req.payload.logger.error({ category: "ADMIN_MCP_AUDIT_WRITE_FAILED" });

  if (klass !== "read")
    try {
      await writeAuditEvent(req.payload, { ...call, phase: "start" });
    } catch {
      logFailedWrite();
      return { refused: "AUDIT_UNAVAILABLE" };
    }

  if (tool !== WHOAMI_TOOL_NAME && (await controlFor(req)).pause) {
    await finish({ ok: false, code: "MCP_PAUSED" }).catch(logFailedWrite);
    return { refused: "MCP_PAUSED" };
  }

  let value: T;
  try {
    value = await execute();
  } catch (error) {
    await finish({ ok: false, code: "TOOL_FAILED" }).catch(logFailedWrite);
    throw error;
  }
  try {
    await finish(outcomeOf(value));
  } catch {
    logFailedWrite();
    if (klass === "read") return { refused: "AUDIT_UNAVAILABLE" };
  }
  return { value };
};

/** Everything else on the plugin path is a write, including any tool added later. */
const PLUGIN_READ_TOOLS: ReadonlySet<string> = new Set([
  WHOAMI_TOOL_NAME,
  "editorial_query",
  "editorial_read",
  "editorial_batch_results",
  "artvenn_users_find",
  "artvenn_content_search",
  "artvenn_comments_query",
  "artvenn_comments_read",
  "artvenn_operations_get",
]);

/** References, never arguments: a caller's key that is not an id is left out. */
const referencesOf = (
  tool: string,
  args: Readonly<Record<string, unknown>>,
) => {
  const { id, idempotencyKey, requestId } = args;
  const dedupeKey = idempotencyKey ?? requestId;
  return {
    ...(tool.startsWith("editorial_") &&
    (typeof id === "string" || typeof id === "number")
      ? { targetType: "catalogs", targetId: String(id) }
      : {}),
    ...(typeof dedupeKey === "string" && /^[\w.:-]{1,128}$/u.test(dedupeKey)
      ? { requestId: dedupeKey }
      : {}),
  };
};

/**
 * Both plugin reply shapes carry `ok` and a fixed `code` in the text, when they fail.
 * A save with no id names the record it created only here, so the finish row takes
 * the id from the reply: the start row cannot know it.
 */
const pluginOutcomeOf =
  (tool: string) =>
  (result: Awaited<ReturnType<PluginTool["handler"]>>): GuardOutcome => {
    const text = result.content[0]?.text ?? "";
    let reply: { ok?: unknown; code?: unknown; id?: unknown } = {};
    try {
      reply = JSON.parse(text) as typeof reply;
    } catch {
      // Not JSON: a success with nothing to read.
    }
    const ok = reply.ok !== false;
    return {
      ok,
      code:
        typeof reply.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(reply.code)
          ? reply.code
          : ok
            ? "OK"
            : "OUTCOME_UNKNOWN",
      responseBytes: Buffer.byteLength(text),
      ...(tool.startsWith("editorial_") &&
      ok &&
      (typeof reply.id === "string" || typeof reply.id === "number")
        ? { targetType: "catalogs", targetId: String(reply.id) }
        : {}),
    };
  };

const chains = new WeakMap<PayloadRequest, Promise<unknown>>();

/**
 * Plugin path. The SDK dispatches JSON-RPC batch entries without awaiting them,
 * the plugin passes one `req` to all of them, and withEditorialTransaction sets and
 * deletes `req.transactionID` on it, so calls sharing a `req` run one at a time. The
 * native path refuses arrays instead. Inside that, each call runs under guardCall,
 * so editorial_* and artvenn_* gain pause and audit and nothing else.
 */
export const withGuard = (tool: PluginTool): PluginTool => ({
  ...tool,
  handler: (args, req, extra) => {
    const previous = chains.get(req) ?? Promise.resolve();
    const result = previous.then(async () => {
      const guarded = await guardCall(
        {
          req,
          tool: tool.name,
          klass: PLUGIN_READ_TOOLS.has(tool.name) ? "read" : "write",
          ...referencesOf(tool.name, args),
        },
        async () => tool.handler(args, req, extra),
        pluginOutcomeOf(tool.name),
      );
      return "refused" in guarded
        ? {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(failedEnvelope(guarded.refused)),
              },
            ],
          }
        : guarded.value;
    });
    chains.set(
      req,
      result.catch(() => undefined),
    );
    return result;
  },
});
