import { ADMIN_FIND_SKIP_MAX } from "@moya/contracts/internal/admin-mcp";
import type {
  AdminFindInput,
  AdminMcpNext,
} from "@moya/contracts/internal/admin-mcp";

export const FIND_TOOL_NAME = "admin_find";

export const FIND_DESCRIPTION = `Resolve a reference in one call: id, pasted public or Admin link, @handle, sourceId, or free text. {query:"/catalog/abc"}, {query:"https://.../?articleId=article-..."}, {query:"兰亭序",type:"catalog"}. resolution says exact, candidates or none. Use resolution.ref for a mutation, never the first candidate. A branch that did not answer is named in meta.sources, never read as zero. Neither none nor a short candidate list proves absence: a draft Catalog is matched on its title only, as typed and by one simplified-traditional conversion, so another form of a character and any draft alias are missed. Community text is matched as stored, with no such conversion. Retry in the other form before saying it does not exist.`;

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
