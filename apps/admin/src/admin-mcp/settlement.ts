import type {
  AdminJobRef,
  AdminMcpNext,
  AiSettlementResult,
} from "@moya/contracts/internal/admin-mcp";
import type { PayloadRequest } from "payload";

import { CommunityOperatorError } from "../community/backend";
import { askCommunity, askSettlement } from "./ops/community-reads";
import type { AdminOpEntry } from "./ops/define";

/**
 * Whether the media work an op queued has finished (admin-mcp-completion-v1 section 9).
 * State commits with the jobs, so an answer read after the commit is the whole of it.
 * `ok:true` waits for the last job, and a read that fails says nothing about them.
 */

export const JOB_TOOL_NAME = "admin_job";

/** A job takes seconds at the least, so asking sooner cannot change the answer. */
const SETTLEMENT_POLL_MS = 2_000;

/** Reads these again without repeating the op. */
export const settlementNext = (refs: readonly AdminJobRef[]): AdminMcpNext => ({
  tool: JOB_TOOL_NAME,
  args: { kind: "settlement", refs: [...refs] },
  afterMs: SETTLEMENT_POLL_MS,
});

/** A retried job answers for itself, and it may be of any kind. */
const readJob = async (
  id: string,
  req: PayloadRequest,
): Promise<AiSettlementResult> => {
  const page = (await askCommunity(
    "read-publishing-jobs",
    { id, page: 1, pageSize: 1 },
    req,
  )) as { readonly items: readonly { readonly state: string }[] };
  const job = page.items[0];
  if (job === undefined) throw new CommunityOperatorError("NOT_FOUND", 404);
  const stopped = job.state === "failed" || job.state === "abandoned";
  return {
    open: job.state === "queued" || job.state === "running" ? 1 : 0,
    failed: stopped ? 1 : 0,
    failedJobs: stopped ? [id] : [],
  };
};

export const readSettlement = (
  ref: AdminJobRef,
  req: PayloadRequest,
): Promise<AiSettlementResult> =>
  ref.type === "publishing_job" ? readJob(ref.id, req) : askSettlement(ref);

/**
 * An op's rule: which subject its media work hangs on, from the command and what the op
 * answered. Null when this command moved no media, so there is nothing to wait for.
 */
export const settledBy = (
  refOf: (input: never, result: never) => AdminJobRef | null,
): AdminOpEntry["completion"] => ({
  kind: "async",
  settle: async (input, result, { req }) => {
    const ref = refOf(input as never, result as never);
    if (ref === null) return { ok: true, code: "OK" };
    const { open, failed, failedJobs, mediaGate } = await readSettlement(
      ref,
      req,
    );
    const gate = mediaGate === undefined ? {} : { mediaGate };
    if (open > 0)
      return {
        ok: false,
        code: "QUEUED",
        state: "media_jobs_open",
        next: settlementNext([ref]),
        ...gate,
      };
    if (failed > 0)
      return {
        ok: false,
        code: "MEDIA_JOB_FAILED",
        jobs: failedJobs,
        ...gate,
      };
    return { ok: true, code: "OK", ...gate };
  },
});
