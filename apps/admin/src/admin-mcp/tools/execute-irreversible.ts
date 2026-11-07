import { adminRunListedShape } from "@moya/contracts/internal/admin-mcp";
import type {
  AdminMcpEnvelope,
  AdminRunInput,
} from "@moya/contracts/internal/admin-mcp";
import type { PayloadRequest } from "payload";
import { z } from "zod";

import type { AdminMcpKey } from "../door";
import { executeRunEnvelope } from "../runs/executor";
import { withinExecuteShare } from "./execute";

export const EXECUTE_IRREVERSIBLE_TOOL_NAME = "admin_execute_irreversible";

export const EXECUTE_IRREVERSIBLE_DESCRIPTION = `Run an irreversible run admin_preview sealed: {requestId,previewId}, or {requestId,runId} to go on. Nothing else travels, so what runs is what was previewed. Past the Owner's threshold it answers AWAITING_OWNER until the Owner confirms; then call again. ok:true only when every target completed.`;

// Plain strings, as on admin_preview: the runtime check takes a uuid only.
export const executeIrreversibleListedInput =
  z.strictObject(adminRunListedShape);

const RUN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The audit start row of a run's call: a safe requestId and the run, by its id. */
export const runReferences = (args: unknown) => {
  const { requestId, previewId, runId } = (args ?? {}) as Record<
    string,
    unknown
  >;
  const run = previewId ?? runId;
  return {
    ...(typeof requestId === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)
      ? { requestId }
      : {}),
    ...(typeof run === "string" && RUN_ID.test(run) ? { runId: run } : {}),
  };
};

export const executeIrreversibleEnvelope = (
  input: unknown,
  context: { readonly key: AdminMcpKey; readonly req: PayloadRequest },
): Promise<AdminMcpEnvelope> =>
  withinExecuteShare(() =>
    executeRunEnvelope(
      input as AdminRunInput,
      EXECUTE_IRREVERSIBLE_TOOL_NAME,
      context,
    ),
  );
