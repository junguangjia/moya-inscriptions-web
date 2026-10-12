import { createExternalStore } from "./upload-manager-store";

import type { ExternalStore } from "./upload-manager-store";
import type {
  WorkSubmissionCommand,
  WorkSubmissionReceipt,
  WorkSubmissionResult,
} from "@moya/contracts";

/**
 * Explicit, idempotent submission (U11, D10, P05): each explicit submit gets
 * one request identity and one frozen command. A lost answer is reconciled by
 * reading the receipt before anything else is offered; without a receipt the
 * author may check again or retry the very same command with the same
 * request identity. Unknown outcomes require an explicit retry; a confirmed
 * submission cannot be sent again from this controller. An explicit
 * queued intent may wait again after a definitive media refusal, preserving
 * its frozen command and request identity.
 */

export interface SubmissionPort {
  submit(cmd: WorkSubmissionCommand): Promise<WorkSubmissionResult>;
  submissionReceipt(requestId: string): Promise<WorkSubmissionReceipt | null>;
}

export type SubmissionState =
  | { readonly status: "idle" }
  /** An explicit publish intent is waiting for its media. */
  | { readonly status: "queued" }
  | { readonly status: "submitting"; readonly requestId: string }
  /** The answer was lost: the receipt is being read (正在确认结果…). */
  | { readonly status: "reconciling"; readonly requestId: string }
  /** No receipt yet: explicit Check again or Retry (same request identity). */
  | {
      readonly status: "unconfirmed";
      readonly requestId: string;
      readonly message: string;
    }
  | { readonly status: "confirmed"; readonly receipt: WorkSubmissionReceipt }
  | { readonly status: "not_ready"; readonly itemKeys: readonly string[] }
  | {
      readonly status: "failed";
      readonly code: string | null;
      readonly message: string;
    };

export type SubmissionInput = Omit<WorkSubmissionCommand, "requestId">;

export interface SubmissionController {
  readonly store: ExternalStore<SubmissionState>;
  /** Accepts an explicit deferred intent without sending a command yet. */
  queue(): void;
  /** A definitive media refusal waits again with the same frozen command. */
  waitForReadiness(): void;
  /** One explicit submit: a new request identity and a frozen command. */
  submit(input: SubmissionInput): Promise<SubmissionState>;
  /** Re-sends the frozen command with the same request identity (only when unconfirmed). */
  retry(): Promise<SubmissionState>;
  /** Reads the receipt again (only when unconfirmed). */
  checkAgain(): Promise<SubmissionState>;
  /** Leaves a failed or not-ready result so a new explicit submit can start. */
  reset(): void;
  /**
   * Records a failure that happened before any command was sent (e.g. the
   * holder could not be resolved), so the editor shows it like any other.
   */
  reportFailure(failure: {
    code: string | null;
    message: string;
  }): SubmissionState;
  dispose(): void;
}

const unconfirmedMessage = "暂时无法确认发布结果，请检查后重试";
const failedMessage = "发布失败，请重试";

interface ErrorShape {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly outcomeUnknown?: unknown;
}

const shape = (error: unknown): ErrorShape =>
  typeof error === "object" && error !== null ? (error as ErrorShape) : {};

export const createSubmissionController = (options: {
  readonly port: SubmissionPort;
  readonly requestId: () => string;
}): SubmissionController => {
  const store = createExternalStore<SubmissionState>({ status: "idle" });
  let command: WorkSubmissionCommand | null = null;
  let disposed = false;

  const set = (next: SubmissionState): SubmissionState => {
    if (!disposed) store.set(next);
    return store.get();
  };

  const reconcile = async (requestId: string): Promise<SubmissionState> => {
    set({ status: "reconciling", requestId });
    try {
      const receipt = await options.port.submissionReceipt(requestId);
      if (disposed) return store.get();
      return receipt !== null && receipt.requestId === requestId
        ? set({ status: "confirmed", receipt })
        : set({
            status: "unconfirmed",
            requestId,
            message: unconfirmedMessage,
          });
    } catch {
      return set({
        status: "unconfirmed",
        requestId,
        message: unconfirmedMessage,
      });
    }
  };

  const send = async (
    frozen: WorkSubmissionCommand,
  ): Promise<SubmissionState> => {
    set({ status: "submitting", requestId: frozen.requestId });
    let result: WorkSubmissionResult;
    try {
      result = await options.port.submit(frozen);
    } catch (error) {
      if (disposed) return store.get();
      const e = shape(error);
      if (e.outcomeUnknown === true) return reconcile(frozen.requestId);
      return set({
        status: "failed",
        code: typeof e.code === "string" ? e.code : null,
        message: typeof e.message === "string" ? e.message : failedMessage,
      });
    }
    if (disposed) return store.get();
    return result.state === "confirmed"
      ? set({ status: "confirmed", receipt: result })
      : set({ status: "not_ready", itemKeys: result.itemKeys });
  };

  const busy = () => {
    const status = store.get().status;
    return (
      status === "submitting" ||
      status === "reconciling" ||
      status === "confirmed"
    );
  };

  return {
    store,
    queue() {
      const status = store.get().status;
      if (
        disposed ||
        (status !== "idle" && status !== "failed" && status !== "not_ready")
      )
        return;
      command = null;
      set({ status: "queued" });
    },
    waitForReadiness() {
      if (!disposed && store.get().status === "not_ready" && command !== null)
        set({ status: "queued" });
    },
    async submit(input) {
      if (disposed || busy() || store.get().status === "unconfirmed")
        return store.get();
      if (store.get().status !== "queued" || command === null)
        command = { ...input, requestId: options.requestId() };
      return send(command);
    },
    async retry() {
      const current = store.get();
      if (disposed || current.status !== "unconfirmed" || command === null)
        return current;
      return send(command);
    },
    async checkAgain() {
      const current = store.get();
      if (disposed || current.status !== "unconfirmed") return current;
      return reconcile(current.requestId);
    },
    reset() {
      const status = store.get().status;
      if (
        status === "queued" ||
        status === "failed" ||
        status === "not_ready"
      ) {
        command = null;
        set({ status: "idle" });
      }
    },
    reportFailure(failure) {
      const status = store.get().status;
      if (
        status !== "idle" &&
        status !== "queued" &&
        status !== "failed" &&
        status !== "not_ready"
      )
        return store.get();
      command = null;
      return set({ status: "failed", ...failure });
    },
    dispose() {
      disposed = true;
    },
  };
};
