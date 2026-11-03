import type { AdminMcpEnvelope } from "./envelope.js";

/** Class decides the tool, so a tool's annotations are always true. */
export type AdminOpClass = "read" | "reversible" | "irreversible";

/** How a retry after a lost answer finds out what happened. */
export type AdminOpRecovery = "receipt" | "cas_read_back" | "state_idempotent";

/** An async op answers from its settlement rule, so accepted never reads as done. */
export type AdminOpCompletion<Input, Context> =
  | { readonly kind: "sync" }
  | {
      readonly kind: "async";
      readonly settle: (
        input: Input,
        context: Context,
      ) => Promise<Pick<AdminMcpEnvelope, "ok" | "code" | "state" | "next">>;
    };

/** The four Owner-only switches. Each stays off until the Owner opens it. */
export type AdminMcpSensitiveCategory =
  "dm" | "evidence" | "rawIp" | "selfOnly";

/**
 * One registry entry. `Input` is the parsed contract input and `Context` the
 * server-side call context, which contracts never name. An irreversible op's
 * class may depend on its input: a save that binds a new identity.
 */
export interface AdminOpMeta<Input, Output, Context> {
  readonly klass:
    AdminOpClass | ((input: Input, context: Context) => Promise<AdminOpClass>);
  readonly sensitive?: AdminMcpSensitiveCategory;
  readonly target: (input: Input) => {
    readonly type: string;
    readonly id?: string;
  };
  /** Shown to the client, never compared with the threshold. */
  readonly impact?: (input: Input, context: Context) => Promise<unknown>;
  readonly preview?: (input: Input, context: Context) => Promise<unknown>;
  readonly run: (input: Input, context: Context) => Promise<Output>;
  readonly recovery: AdminOpRecovery;
  readonly completion: AdminOpCompletion<Input, Context>;
  /** JSON pointers in `Output` holding user-authored strings. */
  readonly untrusted: readonly string[];
  readonly selectorSources?: readonly string[];
}
