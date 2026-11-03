import {
  adminFindDataSchema,
  adminGetDataSchema,
  adminReadCountDataSchema,
} from "@moya/contracts/internal/admin-mcp";

import type { BenchOracle } from "./seed.ts";

// Each task's reference path, as a client with no model would replay it, and its
// grader against the seed's oracle (admin-mcp-completion-v1 section 21). L0 replays
// these in CI and L1 times them. Each slice adds its tasks here.

/** Section 21's Gate A, in ms, proposals to calibrate at first measurement. */
export const GATE_A_P95_MS = {
  door_floor: 100,
  exact_locate: 150,
  single_read: 250,
  list_page: 400,
  aggregate: 500,
  fuzzy_locate: 800,
  media_view: 800,
} as const;

export interface ToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** C1: 「资料库草稿里缺释文的有多少条？按朝代分组给我数字。」 One statement of SQL, no rows. */
export const C1_CALL: ToolCall = {
  name: "admin_read",
  arguments: {
    op: "list.catalogs",
    view: "count",
    groupBy: "dynasty",
    input: { filter: { missing: ["transcription"] } },
  },
};

const groupKey = ({
  state,
  value,
}: {
  readonly state?: string | undefined;
  readonly value: string | null;
}) => `${state}|${value}`;

export const gradeC1 = (
  data: unknown,
  oracle: BenchOracle["c1"],
): readonly string[] => {
  const answer = adminReadCountDataSchema.parse(data);
  const failures: string[] = [];
  if (answer.total !== oracle.total)
    failures.push(`total ${answer.total}, expected ${oracle.total}`);
  const expected = new Map(
    oracle.groups.map((group) => [groupKey(group), group.count]),
  );
  const seen = new Set<string>();
  for (const group of answer.groups ?? []) {
    const key = groupKey(group);
    seen.add(key);
    if (expected.get(key) !== group.count)
      failures.push(`${key}: ${group.count}, expected ${expected.get(key)}`);
  }
  for (const key of expected.keys())
    if (!seen.has(key)) failures.push(`${key}: missing from the answer`);
  return failures;
};

/** C4: 「这个链接对应哪条资料？现在上线了吗？深度缩放是什么状态？/catalog/<id>」 */
export const c4Calls = (catalogId: string, id: number) => ({
  find: {
    name: "admin_find",
    arguments: { query: `/catalog/${catalogId}` },
  } satisfies ToolCall,
  get: {
    name: "admin_get",
    arguments: { type: "catalog", id },
  } satisfies ToolCall,
});

/**
 * The master half reads as not_available until the master routes arrive in a later
 * slice, which the Matrix asks for over a guessed state: it never reads as no master.
 * It is graded as that, and reported as open, because C4's full grader wants the state.
 */
export const gradeC4 = (
  found: unknown,
  got: unknown,
  expected: { readonly id: number; readonly state: string },
): readonly string[] => {
  const failures: string[] = [];
  const find = adminFindDataSchema.parse(found);
  if (find.resolution.status !== "exact" || !find.resolution.uniqueIdentity)
    failures.push(`resolution ${find.resolution.status}`);
  if (find.resolution.ref?.id !== expected.id)
    failures.push(`ref ${find.resolution.ref?.id}, expected ${expected.id}`);
  if (find.items[0]?.state !== expected.state)
    failures.push(`find state ${find.items[0]?.state}`);
  const record = adminGetDataSchema.parse(got) as Record<string, unknown>;
  if (record.id !== expected.id) failures.push(`get id ${String(record.id)}`);
  if (record.state !== expected.state)
    failures.push(`get state ${String(record.state)}`);
  if (record.deepZoom !== "not_available")
    failures.push(`deepZoom ${String(record.deepZoom)}`);
  return failures;
};
