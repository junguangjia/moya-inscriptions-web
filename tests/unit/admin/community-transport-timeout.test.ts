import { afterEach, describe, expect, it, vi } from "vitest";
import { call, outcomeUnknown, OperatorFailure } from "admin/community-api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("bounded community transport", () => {
  it("makes an unconfirmed timed out write retryable with its original identity", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetcher = vi.fn(
      (_url, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          options.signal!.addEventListener("abort", () =>
            reject(new Error("synthetic interrupted transport")),
          ),
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const operation = {
      requestId: "synthetic-same-request",
      expectedVersion: 1,
    };
    const pending = call("set-featured", operation).catch((error) => error);
    deadline.abort();
    const result = await pending;
    expect(result).toBeInstanceOf(OperatorFailure);
    expect(outcomeUnknown(result)).toBe(true);
    expect(fetcher.mock.calls[0]![1].body).toBe(JSON.stringify(operation));
  });
  it("does not reinterpret a caller cancelled read as a write decision", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          options.signal!.addEventListener("abort", () =>
            reject(new DOMException("synthetic cancellation", "AbortError")),
          ),
        ),
    );
    const controller = new AbortController();
    const pending = call("read-users", {}, controller.signal).catch(
      (error) => error,
    );
    controller.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });
  });
});

it.each([400, 422])(
  "keeps a known final %s refusal final when its error body times out",
  async (status) => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let reading!: () => void;
    const ready = new Promise<void>((resolve) => {
      reading = resolve;
    });
    vi.stubGlobal("fetch", async () => ({
      status,
      json: () =>
        new Promise((_resolve, reject) => {
          reading();
          deadline.signal.addEventListener("abort", () =>
            reject(new Error("synthetic response interrupted")),
          );
        }),
    }));
    const pending = call("set-featured", {
      requestId: "synthetic-final-request",
    }).catch((error) => error);
    await ready;
    deadline.abort();
    const result = await pending;
    expect(result).toMatchObject({ code: "OPERATION_FAILED", status });
    expect(outcomeUnknown(result)).toBe(false);
  },
);
