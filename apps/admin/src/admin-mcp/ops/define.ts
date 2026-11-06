import type {
  AdminMcpEnvelope,
  AdminOpMeta,
  AdminOpRecovery,
  AdminReadInput,
} from "@moya/contracts/internal/admin-mcp";
import type { PayloadRequest } from "payload";

import type { AdminMcpKey } from "../door";

/** What an op runs with. Never holds a credential: its transport chooses one. */
export interface AdminOpContext {
  readonly req: PayloadRequest;
  readonly key: AdminMcpKey;
  /** The admin_read call this runs under: paging, view, projection, grouping. */
  readonly read?: Partial<AdminReadInput>;
  /** On admin_execute: this target's idempotency key, from requestId, index and connection. */
  readonly requestKey?: string;
}

/** A write runs with one: a target with none would have no replay to fall back on. */
export const requestKeyOf = ({ requestKey }: AdminOpContext): string => {
  if (requestKey === undefined) throw new Error("WRITE_WITHOUT_REQUEST_KEY");
  return requestKey;
};

/**
 * A read's `run` gets its parsed input. A write's gets what was sent, already checked
 * against `input`: a save reads which keys were sent, and parsing fills in the rest.
 */
export type AdminOpEntry = AdminOpMeta<
  unknown,
  AdminMcpEnvelope,
  AdminOpContext
>;

export const NUMBERED_PAGE_SIZE = 20;

/**
 * The largest page size that starts a page right after the rows read, up to the
 * rows kept or the default page. A size that only shrinks would end at one row a call.
 */
export const numberedPageAfter = (
  page: number,
  pageSize: number,
  kept: number,
) => {
  const offset = (page - 1) * pageSize + kept;
  let size = Math.max(kept, NUMBERED_PAGE_SIZE);
  while (offset % size !== 0) size -= 1;
  return { page: offset / size + 1, pageSize: size };
};

type Facts = Partial<Omit<AdminOpEntry, "summary" | "klass" | "recovery">>;

const sync = { kind: "sync" } as const;
export const asynchronous = { kind: "async" } as const;

const common = {
  credential: "none",
  completion: sync,
  untrusted: [],
} as const satisfies Partial<AdminOpEntry>;

export const readOp = (summary: string, facts: Facts = {}): AdminOpEntry => ({
  ...common,
  summary,
  klass: "read",
  tool: "admin_read",
  recovery: "state_idempotent",
  ...facts,
});

export const reversibleOp = (
  summary: string,
  recovery: AdminOpRecovery,
  facts: Facts = {},
): AdminOpEntry => ({
  ...common,
  summary,
  klass: "reversible",
  tool: "admin_execute",
  recovery,
  ...facts,
});

export const irreversibleOp = (
  summary: string,
  recovery: AdminOpRecovery,
  facts: Facts = {},
): AdminOpEntry => ({
  ...common,
  summary,
  klass: "irreversible",
  tool: "admin_execute_irreversible",
  recovery,
  ...facts,
});

/** The target of an op that names its record in one field of its input. */
export const onField =
  (type: string, field: string) =>
  (input: unknown): { readonly type: string; readonly id?: string } => {
    const value = (input as Record<string, unknown>)[field];
    return {
      type,
      ...(value === undefined ? {} : { id: String(value) }),
    };
  };

/** Synthetic values for examples, built here so no file holds a long literal. */
const syntheticHex = (digit: string) => `${"0".repeat(31)}${digit}`;
export const example = {
  requestId: "00000000-0000-4000-8000-000000000001",
  user: `user-${syntheticHex("1")}`,
  otherUser: `user-${syntheticHex("2")}`,
  work: `work-${syntheticHex("3")}`,
  comment: `comment-${syntheticHex("4")}`,
  thread: `thread-${syntheticHex("5")}`,
  article: `article-${syntheticHex("6")}`,
  report: `report-${syntheticHex("7")}`,
  revision: `work-revision-${syntheticHex("8")}`,
  job: `publishing-job-${syntheticHex("9")}`,
  conversation: `dm-${syntheticHex("a")}`,
  message: `dmsg-${syntheticHex("b")}`,
  digest: "a".repeat(64),
  reason: "Synthetic reason",
} as const;
