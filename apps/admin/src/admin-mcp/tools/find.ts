import {
  ADMIN_FIND_SKIP_MAX,
  adminFindInputSchema,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminFindInput,
  AdminMcpNext,
} from "@moya/contracts/internal/admin-mcp";
import { z } from "zod";

export const FIND_TOOL_NAME = "admin_find";

export const FIND_DESCRIPTION = `Resolve an id, link, @handle, sourceId or text: {query:"/catalog/abc"}. resolution: exact, candidates or none; mutate only resolution.ref. meta.sources names an unanswered branch. Neither none nor a short candidate list proves absence: a draft Catalog matches by title only, as typed or in one simplified-traditional form, not any draft alias; retry the other form.`;

/** What tools/list shows: the record type grows with the registry, so it is a string. */
export const findListedInput = adminFindInputSchema.extend({
  type: z.string().optional(),
});

/** A cut answer goes on after the candidates it kept. */
export const findContinuation = (
  rawInput: unknown,
  kept: readonly unknown[],
): AdminMcpNext | undefined => {
  const input = rawInput as AdminFindInput;
  const skip = (input.skip ?? 0) + kept.length;
  return kept.length === 0 || skip > ADMIN_FIND_SKIP_MAX
    ? undefined
    : { tool: FIND_TOOL_NAME, args: { ...input, skip } };
};
