import { describe, expect, it, vi } from "vitest";

import { createSubmissionController } from "./submission-reconcile";

import type { SubmissionInput, SubmissionPort } from "./submission-reconcile";
import type { WorkSubmissionReceipt } from "@moya/contracts";

const input: SubmissionInput = {
  holder: { draftId: `work-draft-${"1".repeat(32)}` },
  content: {
    title: "题",
    body: "",
    authorship: { kind: "original" },
    visibility: "public",
    items: [],
    coverKey: null,
    coverCrop: null,
  },
  baseRevisionId: null,
};

let ids = 0;
const requestId = () =>
  `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, "0")}`;

const receiptFor = (id: string): WorkSubmissionReceipt => ({
  state: "confirmed",
  requestId: id,
  workId: `work-${"2".repeat(32)}`,
  revisionId: `work-revision-${"3".repeat(32)}`,
  visibility: "public",
  submittedAt: "2026-09-13T12:00:00.000Z",
});

const lost = Object.assign(new Error("网络连接中断，结果尚未确认"), {
  status: 0,
  outcomeUnknown: true,
});

const fakePort = () => ({
  submit: vi.fn<SubmissionPort["submit"]>(async (cmd) =>
    receiptFor(cmd.requestId),
  ),
  submissionReceipt: vi.fn<SubmissionPort["submissionReceipt"]>(
    async () => null,
  ),
});

describe("submission reconciliation", () => {
  it("defers an explicit intent and preserves its command after a definitive not-ready answer", async () => {
    const port = fakePort();
    const identity = vi.fn(requestId);
    port.submit.mockResolvedValueOnce({ state: "not_ready", itemKeys: ["k1"] });
    const controller = createSubmissionController({
      port,
      requestId: identity,
    });
    controller.queue();
    expect(controller.store.get().status).toBe("queued");
    expect(port.submit).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
    expect((await controller.submit(input)).status).toBe("not_ready");
    controller.waitForReadiness();
    expect(
      (
        await controller.submit({
          ...input,
          content: { ...input.content, title: "later" },
        })
      ).status,
    ).toBe("confirmed");
    expect(port.submit.mock.calls[1]![0]).toEqual(
      port.submit.mock.calls[0]![0],
    );
    expect(identity).toHaveBeenCalledOnce();
  });

  it("cancels a queued intent and never queues an unknown outcome automatically", async () => {
    const port = fakePort();
    const controller = createSubmissionController({ port, requestId });
    controller.queue();
    controller.reset();
    expect(controller.store.get().status).toBe("idle");
    expect(port.submit).not.toHaveBeenCalled();
    port.submit.mockRejectedValueOnce(lost);
    await controller.submit(input);
    controller.waitForReadiness();
    controller.queue();
    expect(controller.store.get().status).toBe("unconfirmed");
    expect(port.submit).toHaveBeenCalledOnce();
  });

  it("confirms with one request identity per explicit submit", async () => {
    const port = fakePort();
    const controller = createSubmissionController({ port, requestId });
    const state = await controller.submit(input);
    expect(state).toMatchObject({ status: "confirmed" });
    expect(port.submit).toHaveBeenCalledOnce();
    // A confirmed submission is never sent again.
    await controller.submit(input);
    expect(port.submit).toHaveBeenCalledOnce();
  });

  it("queries the receipt after a lost answer before offering anything", async () => {
    const port = fakePort();
    port.submit.mockRejectedValueOnce(lost);
    port.submissionReceipt.mockImplementationOnce(async (id) => receiptFor(id));
    const controller = createSubmissionController({ port, requestId });
    const seen: string[] = [];
    controller.store.subscribe(() => seen.push(controller.store.get().status));
    const state = await controller.submit(input);
    expect(port.submissionReceipt).toHaveBeenCalledWith(
      port.submit.mock.calls[0]![0].requestId,
    );
    expect(state.status).toBe("confirmed");
    expect(port.submit).toHaveBeenCalledOnce();
  });

  it("stays unconfirmed without a receipt and retries only explicitly with the same identity", async () => {
    const port = fakePort();
    port.submit.mockRejectedValueOnce(lost);
    const controller = createSubmissionController({ port, requestId });
    expect((await controller.submit(input)).status).toBe("unconfirmed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(port.submit).toHaveBeenCalledOnce();
    // A new submit while unconfirmed does not create a second intent.
    await controller.submit(input);
    expect(port.submit).toHaveBeenCalledOnce();
    expect((await controller.checkAgain()).status).toBe("unconfirmed");
    const retried = await controller.retry();
    expect(retried.status).toBe("confirmed");
    expect(port.submit).toHaveBeenCalledTimes(2);
    expect(port.submit.mock.calls[1]![0].requestId).toBe(
      port.submit.mock.calls[0]![0].requestId,
    );
    expect(port.submit.mock.calls[1]![0].content).toEqual(
      port.submit.mock.calls[0]![0].content,
    );
  });

  it("reports refusals and not-ready items, and a later explicit submit gets a new identity", async () => {
    const port = fakePort();
    port.submit.mockRejectedValueOnce(
      Object.assign(new Error("今日新发布作品数量已达上限"), {
        status: 409,
        code: "daily_limit",
        outcomeUnknown: false,
      }),
    );
    port.submit.mockResolvedValueOnce({ state: "not_ready", itemKeys: ["k1"] });
    const controller = createSubmissionController({ port, requestId });
    expect(await controller.submit(input)).toEqual({
      status: "failed",
      code: "daily_limit",
      message: "今日新发布作品数量已达上限",
    });
    expect(port.submissionReceipt).not.toHaveBeenCalled();
    controller.reset();
    expect(await controller.submit(input)).toEqual({
      status: "not_ready",
      itemKeys: ["k1"],
    });
    controller.reset();
    await controller.submit(input);
    const identities = port.submit.mock.calls.map((call) => call[0].requestId);
    expect(new Set(identities).size).toBe(3);
  });
});
