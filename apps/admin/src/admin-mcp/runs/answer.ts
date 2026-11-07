import type {
  AdminExecuteData,
  AdminExecuteRow,
} from "@moya/contracts/internal/admin-mcp";

import type { TargetOutcome } from "../ops/target";

/**
 * How a write's targets read in an answer (admin-mcp-completion-v1 section 7): grouped
 * by state, never one object per target, and an empty group left out. admin_execute
 * groups the targets one call reached; a run's execution groups them the same way.
 */

export const rowOf = ({
  index,
  id,
  code,
  fields,
  replayed,
  lock,
  jobs,
}: TargetOutcome): AdminExecuteRow => ({
  index,
  ...(id === undefined ? {} : { id }),
  code,
  ...(fields === undefined ? {} : { fields: [...fields] }),
  ...(replayed ? { replayed: true as const } : {}),
  ...(lock === undefined ? {} : { lock }),
  ...(jobs === undefined ? {} : { jobs: [...jobs] }),
});

export const dataOf = (
  outcomes: readonly TargetOutcome[],
): AdminExecuteData => {
  const ids = (state: TargetOutcome["state"]) =>
    outcomes
      .filter((outcome) => outcome.state === state)
      .map(({ id, index }) => id ?? `#${index}`);
  const rows = (state: TargetOutcome["state"]) =>
    outcomes.filter((outcome) => outcome.state === state).map(rowOf);
  const queued = outcomes
    .filter(({ state }) => state === "queued")
    .map(({ index, id, settledState, alreadyApplied }) => ({
      index,
      ...(id === undefined ? {} : { id }),
      state: settledState ?? "accepted",
      ...(alreadyApplied ? { alreadyApplied } : {}),
    }));
  const groups: AdminExecuteData = {
    applied: ids("applied"),
    already_applied: ids("already_applied"),
    queued,
    conflict: rows("conflict"),
    failed: rows("failed"),
    unknown: rows("unknown"),
  };
  const moderationCases = outcomes.filter(
    ({ result }) => result?.caseOpened === true,
  ).length;
  return {
    ...(Object.fromEntries(
      Object.entries(groups).filter(
        ([, group]) => Array.isArray(group) && group.length > 0,
      ),
    ) as AdminExecuteData),
    ...(moderationCases === 0 ? {} : { moderationCases }),
  };
};
