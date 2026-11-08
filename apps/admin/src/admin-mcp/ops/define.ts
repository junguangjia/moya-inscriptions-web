import type {
  AdminMcpEnvelope,
  AdminOpClass,
  AdminOpMeta,
  AdminOpRecovery,
  AdminReadInput,
} from "@moya/contracts/internal/admin-mcp";
import type { PayloadRequest } from "payload";

import type { AdminMcpKey } from "../door";

/**
 * The run a target executes under (S8 plan 2.8). Only the run executor issues one, and
 * only an issued one counts: an object of the same shape built anywhere else carries
 * no run header and admits nothing.
 */
export interface RunTicket {
  readonly runId: string;
}

const issuedTickets = new WeakSet<RunTicket>();
const RUN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** For runs/executor.ts alone; tests/unit/architecture/admin-mcp-run-header.test.ts holds it there. */
export const issueRunTicket = (runId: string): RunTicket => {
  if (!RUN_ID.test(runId)) throw new Error("RUN_TICKET_INVALID");
  const ticket: RunTicket = Object.freeze({ runId });
  issuedTickets.add(ticket);
  return ticket;
};

export const isIssuedTicket = (ticket: RunTicket | undefined) =>
  ticket !== undefined && issuedTickets.has(ticket);

/** What an op runs with. Never holds a credential: its transport chooses one. */
export interface AdminOpContext {
  readonly req: PayloadRequest;
  readonly key: AdminMcpKey;
  /** The admin_read call this runs under: paging, view, projection, grouping. */
  readonly read?: Partial<AdminReadInput>;
  /** On admin_execute: this target's idempotency key, from requestId, index and connection. */
  readonly requestKey?: string;
  /** Set by the run executor alone: the frozen run this target belongs to. */
  readonly run?: RunTicket;
}

/** A write runs with one: a target with none would have no replay to fall back on. */
export const requestKeyOf = ({ requestKey }: AdminOpContext): string => {
  if (requestKey === undefined) throw new Error("WRITE_WITHOUT_REQUEST_KEY");
  return requestKey;
};

/**
 * The class the per-target core read for this target's one call, kept by the context
 * itself, so a save's class and its removal check still read through the same context.
 */
const admissions = new WeakMap<AdminOpContext, AdminOpClass>();

/** For ops/target.ts alone, which classifies a target before it runs. */
export const admitTarget = (context: AdminOpContext, klass: AdminOpClass) => {
  admissions.set(context, klass);
};

/**
 * First in each write that may bind an identity for good: it runs only through the
 * per-target core, and only as reversible or inside an issued run. A direct call of
 * its `run`, whatever it was handed, fails here before anything is read or written.
 */
export const requireAdmission = (context: AdminOpContext): void => {
  const klass = admissions.get(context);
  if (
    klass === "reversible" ||
    (klass === "irreversible" && isIssuedTicket(context.run))
  )
    return;
  throw new Error("RUN_ADMISSION_REQUIRED");
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
  run: "00000000-0000-4000-8000-00000000000c",
  digest: "a".repeat(64),
  reason: "Synthetic reason",
} as const;
