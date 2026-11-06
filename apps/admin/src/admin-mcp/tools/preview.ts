import { adminPreviewListedShape } from "@moya/contracts/internal/admin-mcp";
import type { AdminMcpEnvelope } from "@moya/contracts/internal/admin-mcp";
import { z } from "zod";

import { lookupOp } from "../registry";
import { previewEnvelope } from "../runs/preview";
import type { PreviewContext } from "../runs/preview";
import { withinExecuteShare } from "./execute";

export const PREVIEW_TOOL_NAME = "admin_preview";

export const PREVIEW_DESCRIPTION = `Freeze a write before it runs: past 100 targets, or irreversible. {requestId,op,input?,targets,expectedCount?}; more as {requestId,previewId,chunkSeq,appendTargets}. Runs nothing; answers count, conflicts and needsOwnerConfirmation. Then admin_execute or admin_execute_irreversible, as class says, with {requestId,previewId}.`;

// Plain strings and open objects, as on admin_execute: a listed uuid costs 195 bytes a
// field, and the runtime check names a slip by its path.
export const previewListedInput = z.strictObject(adminPreviewListedShape);

/** The audit start row: the registry's name, a safe requestId and how many targets. */
export const previewReferences = (args: unknown) => {
  const { op, requestId, targets, appendTargets } = (args ?? {}) as Record<
    string,
    unknown
  >;
  const found = typeof op === "string" ? lookupOp(op) : undefined;
  const sent = Array.isArray(targets)
    ? targets
    : Array.isArray(appendTargets)
      ? appendTargets
      : undefined;
  return {
    ...(found !== undefined && "op" in found ? { op: found.op } : {}),
    ...(typeof requestId === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)
      ? { requestId }
      : {}),
    ...(sent === undefined ? {} : { count: sent.length }),
  };
};

/** In the share every write takes of the Admin's pool: a preview reads and writes as one. */
export const previewToolEnvelope = (
  input: unknown,
  context: PreviewContext,
): Promise<AdminMcpEnvelope> =>
  withinExecuteShare(() => previewEnvelope(input, context));
