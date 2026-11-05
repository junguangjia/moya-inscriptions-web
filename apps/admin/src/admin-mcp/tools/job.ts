import { ADMIN_JOB_MAX_REFS } from "@moya/contracts/internal/admin-mcp";
import type {
  AdminJobInput,
  AdminJobRef,
  AdminJobRow,
  AdminMcpEnvelope,
  AdminMcpNext,
} from "@moya/contracts/internal/admin-mcp";
import type { PayloadRequest } from "payload";
import { z } from "zod";

import { CommunityOperatorError } from "../../community/backend";
import { EXECUTE_BUDGET_MS } from "../budget";
import { failedEnvelope, okEnvelope } from "../envelope";
import { envelopeCodeOf } from "../refusal";
import { JOB_TOOL_NAME, readSettlement, settlementNext } from "../settlement";

export { JOB_TOOL_NAME };

export const JOB_DESCRIPTION = `How far the media work an op queued has got, without repeating the op. Copy {kind:"settlement",refs} from a QUEUED answer's next. ok:true once no job is open or failed; else QUEUED or MEDIA_JOB_FAILED.`;

// tools/list carries the shape and the runtime check the rest, as on admin_execute.
export const jobListedInput = z.strictObject({
  kind: z.literal("settlement"),
  refs: z.array(z.looseObject({})).min(1).max(ADMIN_JOB_MAX_REFS),
});

/** Refusals a repeat cannot change. Anything else reads as not read, never as a miss. */
const REFUSED: ReadonlySet<string> = new Set([
  "NOT_FOUND",
  "SELF_ONLY_OWNER_REVIEW",
  "AI_CREDENTIAL_NOT_CONFIGURED",
  "AI_ROUTE_FORBIDDEN",
]);

interface Read {
  readonly row: AdminJobRow;
  readonly gateShut: boolean;
}

const readRef = async (
  ref: AdminJobRef,
  req: PayloadRequest,
): Promise<Read> => {
  const named = { type: ref.type, id: ref.id };
  try {
    const { open, failed, failedJobs, mediaGate } = await readSettlement(
      ref,
      req,
    );
    const stopped = failed > 0 ? { failed, jobs: failedJobs } : {};
    return {
      row:
        open > 0
          ? { ...named, state: "open", open, ...stopped }
          : { ...named, state: failed > 0 ? "failed" : "settled", ...stopped },
      gateShut: mediaGate !== undefined,
    };
  } catch (error) {
    return {
      row:
        error instanceof CommunityOperatorError && REFUSED.has(error.code)
          ? { ...named, state: "refused", code: error.code }
          : { ...named, state: "unread" },
      gateShut: false,
    };
  }
};

/** What this read found: an open job first, because the worker may yet get past a stop. */
const answerOf = (
  refs: readonly AdminJobRef[],
  rows: readonly AdminJobRow[],
): AdminMcpEnvelope => {
  const data = { refs: [...rows] };
  const waiting = rows.flatMap((row, index) =>
    row.state === "open" || row.state === "unread" ? [refs[index]!] : [],
  );
  if (rows.length < refs.length)
    return failedEnvelope("IN_PROGRESS", {
      data,
      next: settlementNext([...waiting, ...refs.slice(rows.length)]),
      remaining: refs.length - rows.length,
    });
  if (waiting.length > 0)
    return failedEnvelope("QUEUED", {
      data,
      state: rows.some(({ state }) => state === "open")
        ? "media_jobs_open"
        : "settlement_unread",
      next: settlementNext(waiting),
    });
  if (rows.some(({ state }) => state === "failed"))
    return failedEnvelope("MEDIA_JOB_FAILED", { data });
  const refused = rows.find(({ state }) => state === "refused");
  if (refused === undefined) return okEnvelope(data);
  return failedEnvelope(
    rows.length === 1 ? envelopeCodeOf(refused.code!) : "PARTIAL",
    { data },
  );
};

/** One call. Past the budget the rest wait, and nothing reads as read that was not. */
export const jobEnvelope = async (
  rawInput: unknown,
  req: PayloadRequest,
): Promise<AdminMcpEnvelope> => {
  const { refs } = rawInput as AdminJobInput;
  const started = performance.now();
  const reads: Read[] = [];
  for (const ref of refs) {
    if (performance.now() - started >= EXECUTE_BUDGET_MS) break;
    reads.push(await readRef(ref, req));
  }
  const answer = answerOf(
    refs,
    reads.map(({ row }) => row),
  );
  return reads.some(({ gateShut }) => gateShut)
    ? { ...answer, meta: { ...answer.meta, mediaGate: "off" } }
    : answer;
};

/** A cut answer goes on from the first ref it left out. */
export const jobContinuation = (
  rawInput: unknown,
  kept: readonly unknown[],
): AdminMcpNext | undefined => {
  const rest = (rawInput as AdminJobInput).refs.slice(kept.length);
  return rest.length === 0 ? undefined : settlementNext(rest);
};
