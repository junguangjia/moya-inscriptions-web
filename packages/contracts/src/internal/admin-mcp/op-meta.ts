import type { z } from "zod";

import type { AdminMcpEnvelope } from "./envelope.js";

/** Class decides the tool, so a tool's annotations are always true. */
export type AdminOpClass = "read" | "reversible" | "irreversible";

/**
 * The tools an op can run on: read to admin_read, a sensitive read to
 * admin_sensitive_read, reversible to admin_execute, irreversible to admin_preview
 * then admin_execute_irreversible. No tool mixes read and write.
 */
export const ADMIN_OP_TOOLS = [
  "admin_read",
  "admin_sensitive_read",
  "admin_execute",
  "admin_execute_irreversible",
] as const;
export type AdminOpTool = (typeof ADMIN_OP_TOOLS)[number];

/** How a retry after a lost answer finds out what happened. */
export type AdminOpRecovery = "receipt" | "cas_read_back" | "state_idempotent";

/** Which Backend credential an op needs; `none` runs in Admin on the Local API. */
export type AdminOpCredential = "none" | "base" | "community";

/** An async op answers from its settlement rule, so accepted never reads as done. */
export type AdminOpCompletion<Input, Context> =
  | { readonly kind: "sync" }
  | {
      readonly kind: "async";
      /**
       * Read again on a replay. Absent, the op answers QUEUED: nothing has shown it
       * finished, so it never reads as done. `result` is what the op answered, and
       * absent when the op found its effect already in place and wrote nothing. A
       * `hint` replaces the code's, when more calls cannot change this answer.
       */
      readonly settle?: (
        input: Input,
        result: unknown,
        context: Context,
      ) => Promise<
        Pick<AdminMcpEnvelope, "ok" | "code" | "state" | "next" | "hint">
      >;
    };

/** The four Owner-only switches. Each stays off until the Owner opens it. */
export type AdminMcpSensitiveCategory =
  "dm" | "evidence" | "rawIp" | "selfOnly";

/**
 * A checked answer, by actor. No `owner`: the Owner route relays the answer as it
 * always has. No `ai`: AI gets the Owner's shape.
 */
export interface AdminOpOutput {
  readonly owner?: z.ZodType;
  readonly ai?: z.ZodType;
}

/**
 * One registry entry. `Input` is the parsed contract input and `Context` the
 * server-side call context, which contracts never name. The facts hold from the
 * start; behaviour and schemas arrive with the slice that builds the op.
 */
export interface AdminOpMeta<Input, Output, Context> {
  /** Fixed English. Never interpolates content. */
  readonly summary: string;
  readonly klass: AdminOpClass;
  /** Set where the class rises with the input: a save binding a new identity. */
  readonly risesWhen?: string;
  readonly classify?: (input: Input, context: Context) => Promise<AdminOpClass>;
  readonly tool: AdminOpTool;
  readonly credential: AdminOpCredential;
  readonly sensitive?: AdminMcpSensitiveCategory;
  readonly recovery: AdminOpRecovery;
  readonly completion: AdminOpCompletion<Input, Context>;
  /** JSON pointers in `Output` holding user-authored strings. */
  readonly untrusted: readonly string[];
  readonly selectorSources?: readonly string[];
  /**
   * How admin_read goes on from this op: by its last row, or by the `page` and
   * `pageSize` of its own input. Absent: it takes neither, and a cut cannot continue.
   */
  readonly paging?: "keyset" | "numbered";
  /** The most a page holds, whatever `pageSize` asked: the page a cut continues from. */
  readonly pageMax?: number;
  /** On a numbered op that answers rows: which of admin_read's own arguments it reads. */
  readonly readArgs?: readonly ("view" | "fields" | "groupBy")[];
  readonly input?: z.ZodType;
  readonly output?: AdminOpOutput;
  /** A valid `input`, shown by admin_actions and parsed by the registry test. */
  readonly example?: Readonly<Record<string, unknown>>;
  readonly target?: (input: Input) => {
    readonly type: string;
    readonly id?: string;
  };
  /** For DOCUMENT_LOCKED's lock block, when `target` is not the record that is held. */
  readonly lockedRecord?: (
    input: Input,
    context: Context,
  ) => Promise<{ readonly type: string; readonly id?: number }>;
  /** Shown to the client, never compared with the threshold. */
  readonly impact?: (input: Input, context: Context) => Promise<unknown>;
  readonly preview?: (input: Input, context: Context) => Promise<unknown>;
  /** Absent until a slice builds the op; such an op reports not_available. */
  readonly run?: (input: Input, context: Context) => Promise<Output>;
}
