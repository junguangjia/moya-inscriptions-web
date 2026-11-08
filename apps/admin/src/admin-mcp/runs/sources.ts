import { ADMIN_RUN_STAMP_BATCH } from "@moya/contracts/internal/admin-mcp";
import type {
  AiSelectItem,
  AiStampSource,
} from "@moya/contracts/internal/admin-mcp";

import { askStamps } from "../ops/community-reads";

/**
 * Where a run's targets have their state read and frozen (admin-mcp-completion-v1
 * section 8): a community source through the Backend's select route by ids, 100 to a
 * statement. A CMS record's state is the revision its op's input carries, so its
 * source is `none` and nothing is read. The executor reads the same way before it runs
 * a target, so a row that moved since its preview is seen.
 */

/** A source's rows by id; one that is not there is absent from the map. */
export const stampsOf = async (
  source: AiStampSource,
  ids: readonly string[],
): Promise<ReadonlyMap<string, AiSelectItem>> => {
  const found = new Map<string, AiSelectItem>();
  const unique = [...new Set(ids)];
  for (let from = 0; from < unique.length; from += ADMIN_RUN_STAMP_BATCH) {
    const { items } = await askStamps(
      source,
      unique.slice(from, from + ADMIN_RUN_STAMP_BATCH),
    );
    for (const item of items) found.set(item.id, item);
  }
  return found;
};

/** Read by no route: a target whose op stamps nothing holds this, so its run can seal. */
export const NO_STAMP = "none";
/** A stamp a read could not give, so the target is a conflict from its preview on. */
export const ABSENT_STAMP = "absent";

/** Why a row read by id cannot run, as the code its conflict carries. */
export const withheldCode = (item: AiSelectItem | undefined) =>
  item === undefined
    ? "NOT_FOUND"
    : item.withheld === "self_only"
      ? "SELF_ONLY_OWNER_REVIEW"
      : item.withheld === "personal_info"
        ? "PERSONAL_INFO_OWNER_REVIEW"
        : undefined;
