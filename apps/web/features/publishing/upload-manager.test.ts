import { describe, expect, it, vi } from "vitest";

import { contentIdentifierSha256 } from "./parsers/apple-live-photo";
import { IDENTIFIER } from "./parsers/synthetic-media.test-support";
import {
  canRetryProcessing,
  readinessText,
  summarizeUploads,
} from "./upload-manager";
import {
  ACCOUNT,
  DRAFT_ID,
  OTHER_ACCOUNT,
  SESSION_ID,
  clientError,
  createTestManager,
  liveSource,
  settle,
  staticSource,
} from "./upload-manager.test-support";

import type { LogicalSource } from "./import-grouping";
import type { MediaMetadata, PublishingDraft } from "@moya/contracts";

const confirm = (
  key: string,
  source: LogicalSource,
  qualityMode: "standard" | "original" = "standard",
) => ({
  key,
  source,
  qualityMode,
  notCameraOriginal: false,
});

describe("upload manager: preparation and registration", () => {
  it("r6 replaces the local Standard source with the actual prepared bytes", async () => {
    const test = createTestManager();
    const source = staticSource();
    test.manager.addConfirmed([confirm("local-recovery", source)]);
    await settle();
    const [entry] = test.manager.checkpoint();
    expect(entry?.source).toBeNull();
    expect(entry?.prepared?.[0]?.blob).toBe(
      test.transfer.starts[0]!.request.body,
    );
    expect(entry?.view.itemId).toMatch(/^media-item-/u);
    await test.manager.cancelItem("local-recovery");
    expect(test.manager.checkpoint()).toEqual([]);
    test.manager.dispose();
  });

  it.each(["standard", "original"] as const)(
    "keeps static presentation and honors supplied-byte rules in %s mode",
    async (quality) => {
      const test = createTestManager();
      const base = staticSource();
      const source: LogicalSource = {
        kind: "static",
        still: {
          ...base.still,
          motionPhoto: {
            primaryLength: 300,
            videoStart: 300,
            videoLength: 700,
            videoType: "video/mp4",
            stillTimeMs: null,
          },
        },
      };
      if (quality === "standard")
        test.preprocess.still.mockResolvedValue({
          status: "retained",
          contentType: "image/jpeg",
          width: 20,
          height: 20,
        });
      test.manager.addConfirmed([confirm("photo", source, quality)]);
      await settle();
      expect(test.preprocess.motion).not.toHaveBeenCalled();
      expect(test.transfer.starts).toHaveLength(1);
      const body = test.transfer.starts[0]!.request.body;
      const expected =
        quality === "original"
          ? source.still.file
          : source.still.file.slice(0, 300);
      expect(body.size).toBe(expected.size);
      expect(await body.arrayBuffer()).toEqual(await expected.arrayBuffer());
      if (quality === "original") {
        expect(body).toBe(source.still.file);
        expect(
          await crypto.subtle.digest("SHA-256", await body.arrayBuffer()),
        ).toEqual(
          await crypto.subtle.digest(
            "SHA-256",
            await source.still.file.arrayBuffer(),
          ),
        );
      }
      expect(test.client.client.registerItem.mock.calls[0]![0]).toMatchObject({
        kind: "static",
        components: [{ role: "still", byteSize: expected.size }],
      });
      test.manager.dispose();
    },
  );

  it("registers a Standard item with final byte sizes before any transfer, sends each component once and polls until ready", async () => {
    const test = createTestManager();
    test.manager.addConfirmed([confirm("k1", staticSource())]);
    await settle();
    expect(test.client.client.registerItem).toHaveBeenCalledOnce();
    const command = test.client.client.registerItem.mock.calls[0]![0];
    expect(command).toMatchObject({
      holder: { draftId: DRAFT_ID },
      kind: "static",
      qualityMode: "standard",
      processingProfile: "standard-image-v1",
      components: [
        {
          role: "still",
          byteSize: 100,
          contentType: "image/webp",
          standardOutcome: "optimized",
        },
      ],
    });
    expect(test.transfer.starts).toHaveLength(1);
    const { request, callbacks } = test.transfer.starts[0]!;
    expect(request.body.size).toBe(100);
    expect(request.headers["x-upload-attempt"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(test.item("k1").phase).toBe("uploading");

    const itemId = test.item("k1").itemId!;
    callbacks.onProgress(50, 100);
    expect(test.item("k1").components[0]!.bytesSent).toBe(50);
    callbacks.onSettled({
      status: 200,
      responseText: test.client.receive(itemId, "still"),
      stalled: false,
    });
    await settle();
    // 100 % transferred is not ready: the account is processing.
    expect(test.item("k1").phase).toBe("processing");
    expect(summarizeUploads(test.manager.getSnapshot())).toMatchObject({
      processing: 1,
      ready: 0,
      blocking: 1,
    });
    test.client.makeReady(itemId);
    test.timers.fireAll();
    await settle();
    expect(test.item("k1").phase).toBe("ready");
    expect(test.item("k1").serverItem?.media).not.toBeNull();
    expect(test.transfer.starts).toHaveLength(1);
    // The saved-draft copy was written after registration and removed once acknowledged.
    expect(test.recovery.save).toHaveBeenCalledOnce();
    expect(test.recovery.remove).toHaveBeenCalledWith(ACCOUNT, DRAFT_ID, "k1");
  });

  it("registers an Original Live Photo from source bytes with only the identifier digest", async () => {
    const test = createTestManager();
    test.manager.addConfirmed([
      confirm("live", liveSource(IDENTIFIER), "original"),
    ]);
    await settle();
    expect(test.preprocess.still).not.toHaveBeenCalled();
    const command = test.client.client.registerItem.mock.calls[0]![0];
    expect(command).toMatchObject({
      kind: "live",
      qualityMode: "original",
      components: [
        { role: "still", byteSize: 1000, contentType: "image/heic" },
        { role: "motion", byteSize: 3000, contentType: "video/quicktime" },
      ],
      clientPairing: {
        method: "apple-content-identifier",
        identifierSha256: contentIdentifierSha256(IDENTIFIER),
      },
    });
    expect(command).not.toHaveProperty("processingProfile");
    expect(command.components[0]).not.toHaveProperty("standardOutcome");
    expect(JSON.stringify(command)).not.toContain(IDENTIFIER);
    expect(
      test.transfer.starts.map((start) => start.request.body.size),
    ).toEqual([1000, 3000]);
  });

  it("asks for an explicit choice when Standard is unsupported and never uploads silently", async () => {
    const test = createTestManager();
    test.preprocess.still.mockResolvedValueOnce({
      status: "unsupported",
      reason: "decode_unsupported",
    });
    test.manager.addConfirmed([
      confirm("heic", { kind: "static", still: liveSource(IDENTIFIER).still }),
    ]);
    await settle();
    expect(test.item("heic")).toMatchObject({
      phase: "needs_choice",
      choice: { reason: "decode_unsupported" },
    });
    expect(test.client.client.registerItem).not.toHaveBeenCalled();
    expect(test.transfer.starts).toHaveLength(0);
    test.manager.chooseOriginal("heic");
    await settle();
    expect(test.client.client.registerItem.mock.calls[0]![0]).toMatchObject({
      qualityMode: "original",
      components: [
        { role: "still", contentType: "image/heic", byteSize: 1000 },
      ],
    });
  });

  it("registers a retained Standard input unchanged with its outcome", async () => {
    const test = createTestManager();
    test.preprocess.still.mockResolvedValueOnce({
      status: "retained",
      contentType: "image/jpeg",
      width: 4,
      height: 3,
    });
    const source = staticSource();
    test.manager.addConfirmed([confirm("kept", source)]);
    await settle();
    expect(
      test.client.client.registerItem.mock.calls[0]![0].components,
    ).toEqual([
      {
        role: "still",
        byteSize: 1000,
        contentType: "image/jpeg",
        standardOutcome: "retained",
      },
    ]);
    expect(test.transfer.starts[0]!.request.body).toBe(source.still.file);
  });

  it("offers Original or remove when a HEIC cannot be reduced in Standard, never the source bytes as Standard", async () => {
    const test = createTestManager();
    test.preprocess.still.mockResolvedValueOnce({
      status: "unsupported",
      reason: "standard_not_smaller",
    });
    const source: LogicalSource = {
      kind: "static",
      still: liveSource(IDENTIFIER).still,
    };
    test.manager.addConfirmed([confirm("heic", source)]);
    await settle();
    expect(test.item("heic")).toMatchObject({
      phase: "needs_choice",
      choice: {
        reason: "standard_not_smaller",
        message: "此文件无法以标准画质缩小，可上传原图或移除",
      },
    });
    expect(test.client.client.registerItem).not.toHaveBeenCalled();
    expect(test.transfer.starts).toHaveLength(0);
    test.manager.chooseOriginal("heic");
    await settle();
    expect(test.client.client.registerItem.mock.calls[0]![0]).toMatchObject({
      qualityMode: "original",
      components: [
        { role: "still", contentType: "image/heic", byteSize: 1000 },
      ],
    });
    expect(test.transfer.starts[0]!.request.body).toBe(source.still.file);
  });

  it.each(["video/quicktime", "video/mp4"] as const)(
    "never registers a HEIC/HEIF still or %s motion as retained Standard, even if preprocessing says so",
    async (motionType) => {
      // A stale worker answer must not turn into a silent source upload (D3).
      const test = createTestManager();
      test.preprocess.still.mockResolvedValueOnce({
        status: "retained",
        contentType: "image/jpeg",
        width: 4,
        height: 3,
      });
      test.manager.addConfirmed([
        confirm("heic", {
          kind: "static",
          still: liveSource(IDENTIFIER).still,
        }),
      ]);
      await settle();
      expect(test.item("heic")).toMatchObject({
        phase: "needs_choice",
        choice: { reason: "standard_not_smaller" },
      });
      test.preprocess.still.mockResolvedValueOnce({
        status: "optimized",
        blob: new Blob([new Uint8Array(100)], { type: "image/webp" }),
        contentType: "image/webp",
        width: 4,
        height: 3,
      });
      test.preprocess.motion.mockResolvedValueOnce({
        status: "retained",
        durationMs: 2900,
        hasAudio: true,
      });
      const source = liveSource(IDENTIFIER);
      if (source.kind !== "live" || source.layout !== "pair")
        throw new Error("Expected a complete paired fixture");
      test.manager.addConfirmed([
        confirm("live", {
          ...source,
          motion: { ...source.motion, type: motionType },
        }),
      ]);
      await settle();
      expect(test.item("live")).toMatchObject({
        phase: "needs_choice",
        choice: { reason: "standard_not_smaller" },
      });
      expect(test.client.client.registerItem).not.toHaveBeenCalled();
      expect(test.transfer.starts).toHaveLength(0);
    },
  );

  it("makes a Live Photo whose HEIC still cannot be reduced an explicit choice for the whole item", async () => {
    const test = createTestManager();
    test.preprocess.still.mockResolvedValueOnce({
      status: "unsupported",
      reason: "standard_not_smaller",
    });
    test.manager.addConfirmed([confirm("live", liveSource(IDENTIFIER))]);
    await settle();
    expect(test.item("live")).toMatchObject({
      phase: "needs_choice",
      choice: { reason: "standard_not_smaller" },
    });
    expect(test.preprocess.motion).not.toHaveBeenCalled();
    expect(test.client.client.registerItem).not.toHaveBeenCalled();
    test.manager.chooseOriginal("live");
    await settle();
    expect(test.client.client.registerItem.mock.calls[0]![0]).toMatchObject({
      kind: "live",
      qualityMode: "original",
      components: [
        { role: "still", contentType: "image/heic" },
        { role: "motion", contentType: "video/quicktime" },
      ],
    });
  });
});

describe("upload manager: cancellation and stale answers", () => {
  it("cancels one item and ignores a late upload answer for it", async () => {
    const test = createTestManager();
    test.manager.addConfirmed([
      confirm("a", staticSource()),
      confirm("b", staticSource()),
    ]);
    await settle();
    const itemId = test.item("a").itemId!;
    const late = test.transfer.starts.find((start) =>
      start.request.endpoint.includes(
        test.client.items.get(itemId)!.components[0]!.id,
      ),
    )!;
    await test.manager.cancelItem("a");
    expect(test.transfer.transfer.abort).toHaveBeenCalledWith(late.request.id);
    expect(test.client.client.cancelItem).toHaveBeenCalledWith(
      itemId,
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    expect(test.item("a").phase).toBe("cancelled");
    const resultCalls = test.client.client.uploadResult.mock.calls.length;
    late.callbacks.onSettled({
      status: 200,
      responseText: test.client.receive(itemId, "still"),
      stalled: false,
    });
    await settle();
    expect(test.manager.ignoredLateAnswers).toBe(1);
    expect(test.client.client.uploadResult).toHaveBeenCalledTimes(resultCalls);
    expect(test.item("a").phase).toBe("cancelled");
    // The other item is untouched and the draft is not cancelled.
    expect(test.item("b").phase).toBe("uploading");
    expect(test.manager.draftItems().map((item) => item.key)).toEqual(["b"]);
  });

  it("does not let a registration answer re-add an item cancelled meanwhile", async () => {
    const test = createTestManager();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const register = test.client.client.registerItem.getMockImplementation()!;
    test.client.client.registerItem.mockImplementationOnce(async (cmd) => {
      await gate;
      return register(cmd);
    });
    test.manager.addConfirmed([confirm("c", staticSource())]);
    await settle();
    expect(test.item("c").phase).toBe("registering");
    await test.manager.cancelItem("c");
    release();
    await settle();
    expect(test.item("c").phase).toBe("cancelled");
    expect(test.item("c").itemId).toBeNull();
    expect(test.transfer.starts).toHaveLength(0);
    const created = [...test.client.items.keys()][0]!;
    expect(test.client.client.cancelItem).toHaveBeenCalledWith(
      created,
      expect.anything(),
    );
  });
});

describe("upload manager: explicit retries only", () => {
  it("retries only the failed component, from the start, with a new attempt", async () => {
    const test = createTestManager();
    test.manager.addConfirmed([confirm("live", liveSource(IDENTIFIER))]);
    await settle();
    const itemId = test.item("live").itemId!;
    const [stillStart, motionStart] = test.transfer.starts;
    stillStart!.callbacks.onSettled({
      status: 200,
      responseText: test.client.receive(itemId, "still"),
      stalled: false,
    });
    motionStart!.callbacks.onSettled({
      status: 0,
      responseText: "",
      stalled: false,
    });
    await settle();
    expect(test.client.client.item).toHaveBeenCalledWith(itemId);
    expect(test.item("live").phase).toBe("failed");
    expect(test.item("live").components.map((c) => c.phase)).toEqual([
      "received",
      "failed",
    ]);
    test.timers.fireAll();
    await settle();
    expect(test.transfer.starts).toHaveLength(2);

    await test.manager.retryComponent("live", "motion");
    await settle();
    expect(test.client.client.resetComponent).toHaveBeenCalledOnce();
    expect(
      test.client.client.resetComponent.mock.calls[0]!.slice(0, 2),
    ).toEqual([itemId, "motion"]);
    expect(test.transfer.starts).toHaveLength(3);
    const retry = test.transfer.starts[2]!.request;
    expect(retry.endpoint).toBe(motionStart!.request.endpoint);
    expect(retry.headers["x-upload-attempt"]).not.toBe(
      motionStart!.request.headers["x-upload-attempt"],
    );
    expect(retry.body.size).toBe(200);
  });

  it("does not resend after a lost connection or stall until Continue is chosen", async () => {
    const test = createTestManager();
    test.manager.addConfirmed([confirm("s", staticSource())]);
    await settle();
    test.transfer.starts[0]!.callbacks.onSettled({
      status: 0,
      responseText: "",
      stalled: true,
    });
    await settle();
    expect(test.item("s")).toMatchObject({
      phase: "failed",
      failure: { code: "stalled" },
    });
    for (let round = 0; round < 3; round += 1) {
      test.timers.fireAll();
      await settle();
    }
    expect(test.transfer.starts).toHaveLength(1);
    expect(test.client.client.resetComponent).not.toHaveBeenCalled();
    await test.manager.continueUploads();
    await settle();
    expect(test.transfer.starts).toHaveLength(2);
  });

  it("reconciles an unconfirmed upload by reading the item before offering a retry", async () => {
    const test = createTestManager();
    test.manager.addConfirmed([confirm("r", staticSource())]);
    await settle();
    const itemId = test.item("r").itemId!;
    test.client.receive(itemId, "still");
    test.transfer.starts[0]!.callbacks.onSettled({
      status: 502,
      responseText: "",
      stalled: false,
    });
    await settle();
    expect(test.client.client.item).toHaveBeenCalledWith(itemId);
    expect(test.item("r").phase).toBe("processing");
    expect(test.item("r").failure).toBeNull();
  });
});

describe("upload manager: account isolation and no-save mode", () => {
  it("pauses on an account change and never starts a transfer for another account", async () => {
    const test = createTestManager();
    test.manager.addConfirmed([
      confirm("x", staticSource()),
      confirm("y", staticSource()),
    ]);
    await settle();
    expect(test.transfer.starts).toHaveLength(2);
    test.setAccount(OTHER_ACCOUNT);
    test.manager.pause("account");
    expect(test.transfer.transfer.abort).toHaveBeenCalledTimes(2);
    expect(test.manager.getSnapshot()).toMatchObject({
      status: "paused",
      pauseReason: "account",
    });
    const headers = test.client.client.uploadHeaders.mock.calls.length;
    await test.manager.continueUploads();
    await settle();
    expect(test.client.client.uploadHeaders).toHaveBeenCalledTimes(headers);
    expect(test.client.client.resetComponent).not.toHaveBeenCalled();
    expect(test.transfer.starts).toHaveLength(2);
    // Aborted answers that still arrive are ignored.
    test.transfer.starts[0]!.callbacks.onSettled({
      status: 200,
      responseText: "{}",
      stalled: false,
    });
    await settle();
    expect(test.manager.ignoredLateAnswers).toBe(1);
    expect(test.manager.resumeIfIdle()).toBe(false);
  });

  it("pauses before registering when the confirmed account no longer matches", async () => {
    const test = createTestManager();
    test.setAccount(null);
    test.manager.addConfirmed([confirm("z", staticSource())]);
    await settle();
    expect(test.client.client.registerItem).not.toHaveBeenCalled();
    expect(test.manager.getSnapshot().status).toBe("paused");
  });

  it("never writes a local recovery copy in no-save mode", async () => {
    const test = createTestManager({ saveMode: "unsaved" });
    test.manager.addConfirmed([confirm("n", staticSource())]);
    await settle();
    expect(test.client.client.registerItem.mock.calls[0]![0].holder).toEqual({
      sessionId: expect.stringMatching(/^publishing-session-/u),
    });
    const itemId = test.item("n").itemId!;
    test.transfer.starts[0]!.callbacks.onSettled({
      status: 200,
      responseText: test.client.receive(itemId, "still"),
      stalled: false,
    });
    await settle();
    expect(test.recovery.save).not.toHaveBeenCalled();
    expect(test.recovery.remove).not.toHaveBeenCalled();
    expect(test.recovery.list).not.toHaveBeenCalled();
  });
});

describe("upload manager: restore and readiness", () => {
  it("restores a saved draft: account media, recoverable local bytes and items to re-select", async () => {
    const test = createTestManager();
    const recoverableId = `media-item-${"1".repeat(32)}`;
    const readyId = `media-item-${"2".repeat(32)}`;
    const component = `media-component-${"3".repeat(32)}`;
    test.client.items.set(recoverableId, {
      id: recoverableId,
      kind: "static",
      qualityMode: "standard",
      state: "awaiting_upload",
      failureCode: null,
      components: [
        {
          id: component,
          role: "still",
          state: "awaiting",
          byteSize: 5,
          receivedBytes: 0,
        },
      ],
      presentation: null,
      media: null,
    });
    test.recovery.list.mockResolvedValueOnce([
      {
        accountId: ACCOUNT,
        draftId: DRAFT_ID,
        itemKey: "local",
        itemId: recoverableId,
        kind: "static",
        qualityMode: "standard",
        components: [
          {
            role: "still",
            componentId: component,
            contentType: "image/webp",
            byteSize: 5,
            standardOutcome: "optimized",
            blob: new Blob([new Uint8Array(5)]),
          },
        ],
        savedAt: 1,
      },
    ]);
    const draft: PublishingDraft = {
      id: DRAFT_ID,
      kind: "new",
      workId: null,
      baseRevisionId: null,
      revision: 3,
      content: {
        title: "",
        body: "",
        authorship: { kind: "original" },
        visibility: "public",
        items: [
          {
            key: "local",
            itemId: recoverableId,
            kind: "static",
            qualityMode: "standard",
            edit: { rotation: 0, crop: null },
          },
          {
            key: "done",
            itemId: readyId,
            kind: "static",
            qualityMode: "standard",
            edit: { rotation: 0, crop: null },
          },
          {
            key: "elsewhere",
            itemId: null,
            kind: "live",
            qualityMode: "original",
            edit: { rotation: 0, crop: null },
            pendingLabel: "live",
          },
        ],
        coverKey: null,
        coverCrop: null,
      },
      mediaItems: [
        test.client.items.get(recoverableId)!,
        {
          id: readyId,
          kind: "static",
          qualityMode: "standard",
          state: "ready",
          failureCode: null,
          components: [
            {
              id: `media-component-${"4".repeat(32)}`,
              role: "still",
              state: "verified",
              byteSize: 9,
              receivedBytes: 9,
            },
          ],
          presentation: { width: 4, height: 3 },
          media: {
            thumbSrc: `/api/community/publishing/media/${readyId}/thumb/base`,
            displaySrc: `/api/community/publishing/media/${readyId}/display/base`,
          },
        },
      ],
      conflict: null,
      deviceClass: "desktop",
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:00:00.000Z",
    };
    const plan = await test.manager.restoreDraft(draft);
    expect(plan.map((entry) => [entry.itemKey, entry.disposition])).toEqual([
      ["local", "recoverable"],
      ["done", "on_account"],
      ["elsewhere", "must_reselect"],
    ]);
    expect(
      test.manager.getSnapshot().items.map((item) => [item.key, item.phase]),
    ).toEqual([
      ["local", "paused"],
      ["done", "ready"],
      ["elsewhere", "missing_local"],
    ]);
    const summary = summarizeUploads(test.manager.getSnapshot());
    expect(readinessText(summary)).toBe("1 项已暂停，1 项缺少本地文件");
    // Continuing is explicit and re-sends only from local bytes; the account
    // still waits for that component, so nothing is reset first.
    expect(test.transfer.starts).toHaveLength(0);
    await test.manager.continueUploads();
    await settle();
    expect(test.client.client.item).toHaveBeenCalledWith(recoverableId);
    expect(test.client.client.resetComponent).not.toHaveBeenCalled();
    expect(test.transfer.starts).toHaveLength(1);
    expect(test.transfer.starts[0]!.request.body.size).toBe(5);
  });
});

const received = (
  test: ReturnType<typeof createTestManager>,
  index: number,
  role: "still" | "motion" = "still",
) => {
  const start = test.transfer.starts[index]!;
  const itemId = [...test.client.items.values()].find((item) =>
    item.components.some((c) => start.request.endpoint.endsWith(c.id)),
  )!.id;
  start.callbacks.onSettled({
    status: 200,
    responseText: test.client.receive(itemId, role),
    stalled: false,
  });
  return itemId;
};

describe("upload manager: pauses never strand work (review fixes)", () => {
  it("resumes a component whose upload answer came back after the account changed", async () => {
    const test = createTestManager();
    test.manager.addConfirmed([confirm("a", staticSource())]);
    await settle();
    test.setAccount(OTHER_ACCOUNT);
    test.client.client.uploadResult.mockImplementationOnce(() => {
      throw clientError(401, "账户状态已变化，请刷新后检查操作结果", true);
    });
    test.transfer.starts[0]!.callbacks.onSettled({
      status: 0,
      responseText: "",
      stalled: false,
    });
    await settle();
    expect(test.manager.getSnapshot().status).toBe("paused");
    expect(test.item("a")).toMatchObject({
      phase: "paused",
      components: [{ phase: "paused", failure: { outcomeUnknown: true } }],
    });
    test.setAccount(ACCOUNT);
    await test.manager.continueUploads();
    await settle();
    // The account saw an attempt (receiving): it is reset, then sent again once.
    expect(test.client.client.resetComponent).toHaveBeenCalledOnce();
    expect(test.transfer.starts).toHaveLength(2);
    expect(test.item("a").phase).toBe("uploading");
  });

  it("keeps a queued component resumable when the account check stops the queue", async () => {
    const test = createTestManager({ transferConcurrency: 1 });
    test.manager.addConfirmed([
      confirm("first", staticSource()),
      confirm("second", staticSource()),
    ]);
    await settle();
    expect(test.transfer.starts).toHaveLength(1);
    test.setAccount(OTHER_ACCOUNT);
    received(test, 0);
    await settle();
    expect(test.manager.getSnapshot().status).toBe("paused");
    expect(test.item("second").components[0]!.phase).toBe("paused");
    test.setAccount(ACCOUNT);
    await test.manager.continueUploads();
    await settle();
    expect(test.transfer.starts).toHaveLength(2);
    // It never reached the account, so nothing was reset.
    expect(test.client.client.resetComponent).not.toHaveBeenCalled();
  });

  it("prepares again after a pause during metadata extraction and registers with the metadata", async () => {
    let release!: () => void;
    const parsed: MediaMetadata = {
      provenance: { source: "client", parser: "exifr@7.1.3", status: "parsed" },
      values: {},
    };
    const metadata = vi
      .fn<(file: Blob) => Promise<MediaMetadata>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(parsed);
          }),
      )
      .mockImplementation(async () => parsed);
    const test = createTestManager({ metadata });
    test.manager.addConfirmed([confirm("m", staticSource())]);
    await settle();
    expect(test.item("m").phase).toBe("preprocessing");
    test.manager.pause("offline");
    release();
    await settle();
    expect(test.item("m").phase).toBe("waiting");
    expect(test.client.client.registerItem).not.toHaveBeenCalled();
    await test.manager.continueUploads();
    await settle();
    expect(test.client.client.registerItem.mock.calls[0]![0].metadata).toEqual(
      parsed,
    );
    expect(test.transfer.starts).toHaveLength(1);
  });

  it("shows the holder's own refusal (draft limit) instead of a generic message", async () => {
    const test = createTestManager();
    test.holder.mockRejectedValueOnce(
      clientError(409, "草稿数量已达上限", false, "draft_limit"),
    );
    test.manager.addConfirmed([confirm("d", staticSource())]);
    await settle();
    expect(test.item("d")).toMatchObject({
      phase: "failed",
      failure: { code: "draft_limit", message: "草稿数量已达上限" },
    });
    expect(test.client.client.registerItem).not.toHaveBeenCalled();
  });

  it("Continue never resets bytes the account already received", async () => {
    const test = createTestManager();
    test.manager.addConfirmed([confirm("r", staticSource())]);
    await settle();
    const itemId = test.item("r").itemId!;
    // The bytes arrived, but the answer is lost when the pause aborts the transfer.
    test.client.receive(itemId, "still");
    test.manager.pause("offline");
    expect(test.item("r").phase).toBe("paused");
    await test.manager.continueUploads();
    await settle();
    expect(test.client.client.resetComponent).not.toHaveBeenCalled();
    expect(test.transfer.starts).toHaveLength(1);
    expect(test.item("r").phase).toBe("processing");
  });
});

describe("upload manager: processing status checks", () => {
  const delays = (test: ReturnType<typeof createTestManager>) =>
    [...test.timers.pending.values()].map((timer) => timer.ms);

  it("observes seven pending items within five seconds of readiness without resending them", async () => {
    const test = createTestManager();
    const keys = Array.from({ length: 7 }, (_, index) => `photo-${index}`);
    test.manager.addConfirmed(keys.map((key) => confirm(key, staticSource())));
    await settle();
    for (let index = 0; index < keys.length; index += 1) {
      received(test, index);
      await settle();
    }
    expect(test.transfer.starts).toHaveLength(7);
    expect(test.client.client.registerItem).toHaveBeenCalledTimes(7);
    expect(summarizeUploads(test.manager.getSnapshot()).processing).toBe(7);

    let elapsed = 0;
    const serverReadyAt = 20_000;
    while (elapsed < serverReadyAt) {
      const scheduled = delays(test);
      expect(scheduled).toHaveLength(7);
      expect(new Set(scheduled).size).toBe(1);
      const delay = scheduled[0]!;
      expect(delay).toBeLessThanOrEqual(5000);
      elapsed += delay;
      if (elapsed >= serverReadyAt)
        for (const key of keys) test.client.makeReady(test.item(key).itemId!);
      test.timers.fireAll();
      await settle();
    }

    expect(elapsed).toBeLessThanOrEqual(serverReadyAt + 5000);
    expect(summarizeUploads(test.manager.getSnapshot())).toMatchObject({
      ready: 7,
      blocking: 0,
      processing: 0,
    });
    expect(delays(test)).toEqual([]);
    expect(test.transfer.starts).toHaveLength(7);
    expect(test.client.client.registerItem).toHaveBeenCalledTimes(7);
    expect(test.client.client.resetComponent).not.toHaveBeenCalled();
    test.manager.dispose();
  });

  it("backs off failed status checks separately and resets the failure count after a successful check", async () => {
    const test = createTestManager();
    test.manager.addConfirmed([confirm("pending", staticSource())]);
    await settle();
    const itemId = received(test, 0);
    await settle();
    expect(delays(test)).toEqual([1000]);

    for (const delay of [5000, 8000, 13_000, 20_000, 30_000, 30_000]) {
      test.client.client.item.mockRejectedValueOnce(new Error("offline"));
      test.timers.fireAll();
      await settle();
      expect(test.item("pending").phase).toBe("processing");
      expect(delays(test)).toEqual([delay]);
    }

    test.timers.fireAll();
    await settle();
    expect(delays(test)).toEqual([5000]);
    test.client.client.item.mockRejectedValueOnce(new Error("offline"));
    test.timers.fireAll();
    await settle();
    expect(delays(test)).toEqual([5000]);

    test.client.makeReady(itemId);
    test.timers.fireAll();
    await settle();
    expect(test.item("pending").phase).toBe("ready");
    expect(delays(test)).toEqual([]);
    expect(test.transfer.starts).toHaveLength(1);
    expect(test.client.client.registerItem).toHaveBeenCalledOnce();
    expect(test.client.client.resetComponent).not.toHaveBeenCalled();
    test.manager.dispose();
  });

  it.each(["pause", "dispose"] as const)(
    "%s cancels an error-backoff timer without sending more requests",
    async (action) => {
      const test = createTestManager();
      test.manager.addConfirmed([confirm("pending", staticSource())]);
      await settle();
      received(test, 0);
      await settle();
      test.client.client.item.mockRejectedValueOnce(new Error("offline"));
      test.timers.fireAll();
      await settle();
      expect(delays(test)).toEqual([5000]);
      const reads = test.client.client.item.mock.calls.length;

      if (action === "pause") test.manager.pause("offline");
      else test.manager.dispose();
      expect(delays(test)).toEqual([]);
      test.timers.fireAll();
      await settle();
      expect(test.client.client.item).toHaveBeenCalledTimes(reads);
      expect(test.transfer.starts).toHaveLength(1);
      if (action === "pause") {
        expect(test.manager.getSnapshot().status).toBe("paused");
        test.manager.dispose();
      }
    },
  );

  it("ignores a status answer arriving after the manager was paused", async () => {
    const test = createTestManager();
    test.manager.addConfirmed([confirm("pending", staticSource())]);
    await settle();
    const itemId = received(test, 0);
    await settle();
    let release: (
      item: ReturnType<typeof test.client.makeReady>,
    ) => void = () => undefined;
    test.client.client.item.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    test.timers.fireAll();
    await settle();
    test.manager.pause("offline");
    release(test.client.makeReady(itemId));
    await settle();

    expect(test.item("pending").phase).not.toBe("ready");
    expect(test.manager.getSnapshot().status).toBe("paused");
    expect(delays(test)).toEqual([]);
    expect(test.transfer.starts).toHaveLength(1);
    test.manager.dispose();
  });
});

describe("upload manager: integrity, processing retries and unavailable items", () => {
  it("cancels a registration whose received bytes differ from the selection and never shows it received again", async () => {
    let digest = "a".repeat(64);
    const test = createTestManager({
      hasher: { hash: vi.fn(async () => digest) },
    });
    test.manager.addConfirmed([confirm("live", liveSource(IDENTIFIER))]);
    await settle();
    const itemId = test.item("live").itemId!;
    const [still, motion] = test.transfer.starts;
    still!.callbacks.onSettled({
      status: 200,
      responseText: test.client.receive(itemId, "still"),
      stalled: false,
    });
    await settle();
    expect(test.item("live")).toMatchObject({
      phase: "failed",
      itemId: null,
      failure: { code: "integrity_mismatch" },
    });
    expect(test.client.client.cancelItem).toHaveBeenCalledWith(
      itemId,
      expect.anything(),
    );
    expect(test.transfer.transfer.abort).toHaveBeenCalledWith(
      motion!.request.id,
    );
    // The other component's late answer and any timer change nothing.
    motion!.callbacks.onSettled({
      status: 200,
      responseText: test.client.receive(itemId, "motion"),
      stalled: false,
    });
    test.timers.fireAll();
    await settle();
    expect(test.item("live")).toMatchObject({ phase: "failed", itemId: null });
    expect(test.manager.draftItems()[0]!.itemId).toBeNull();

    digest = "0".repeat(64);
    test.manager.retryRegistration("live");
    await settle();
    expect(test.client.client.registerItem).toHaveBeenCalledTimes(2);
    expect(test.transfer.starts).toHaveLength(4);
    expect(test.item("live").itemId).not.toBe(itemId);
  });

  it("offers an explicit re-send after a retryable processing failure only", async () => {
    const test = createTestManager();
    test.manager.addConfirmed([confirm("p", staticSource())]);
    await settle();
    const itemId = received(test, 0);
    await settle();
    test.client.failProcessing(itemId, "processing_timeout");
    test.timers.fireAll();
    await settle();
    expect(test.item("p")).toMatchObject({
      phase: "failed",
      failure: { code: "processing_timeout" },
    });
    expect(canRetryProcessing(test.item("p"))).toBe(true);
    await test.manager.retryProcessing("p");
    await settle();
    expect(test.client.client.resetComponent).toHaveBeenCalledOnce();
    expect(test.transfer.starts).toHaveLength(2);
    expect(test.item("p").phase).toBe("uploading");

    test.client.failProcessing(itemId, "pairing_mismatch");
    received(test, 1);
    test.client.failProcessing(itemId, "pairing_mismatch");
    test.timers.fireAll();
    await settle();
    expect(canRetryProcessing(test.item("p"))).toBe(false);
  });

  it("stops polling an item the account no longer has", async () => {
    const test = createTestManager();
    test.manager.addConfirmed([confirm("g", staticSource())]);
    await settle();
    const itemId = received(test, 0);
    await settle();
    test.client.items.delete(itemId);
    test.timers.fireAll();
    await settle();
    expect(test.item("g")).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable" },
    });
    const reads = test.client.client.item.mock.calls.length;
    for (let round = 0; round < 3; round += 1) {
      test.timers.fireAll();
      await settle();
    }
    expect(test.client.client.item).toHaveBeenCalledTimes(reads);
    expect(test.timers.pending.size).toBe(0);
  });

  it("stores nameless local copies and sends the Apple still time with the pairing", async () => {
    const test = createTestManager();
    test.manager.addConfirmed([
      confirm("o", liveSource(IDENTIFIER, 1500), "original"),
    ]);
    await settle();
    expect(
      test.client.client.registerItem.mock.calls[0]![0].clientPairing,
    ).toEqual({
      method: "apple-content-identifier",
      identifierSha256: contentIdentifierSha256(IDENTIFIER),
      stillTimeMs: 1500,
    });
    const record = test.recovery.save.mock.calls[0]![0];
    expect(record.components).toHaveLength(2);
    for (const component of record.components) {
      expect(component.blob).not.toBeInstanceOf(File);
      expect(component.blob.size).toBe(component.byteSize);
    }
  });
});

describe("upload manager: switching a saved draft to no-save", () => {
  it("keeps media the account still has and registers the draft's own media again", async () => {
    const test = createTestManager();
    const revisionItem = `media-item-${"7".repeat(32)}`;
    test.client.items.set(revisionItem, {
      id: revisionItem,
      kind: "static",
      qualityMode: "standard",
      state: "ready",
      failureCode: null,
      components: [
        {
          id: `media-component-${"8".repeat(32)}`,
          role: "still",
          state: "verified",
          byteSize: 9,
          receivedBytes: 9,
        },
      ],
      presentation: { width: 4, height: 3 },
      media: {
        thumbSrc: `/api/community/publishing/media/${revisionItem}/thumb/base`,
        displaySrc: `/api/community/publishing/media/${revisionItem}/display/base`,
      },
    });
    await test.manager.restoreDraft({
      id: DRAFT_ID,
      kind: "edit",
      workId: `work-${"9".repeat(32)}`,
      baseRevisionId: `work-revision-${"6".repeat(32)}`,
      revision: 2,
      content: {
        title: "旧作",
        body: "",
        authorship: { kind: "original" },
        visibility: "public",
        items: [
          {
            key: "kept",
            itemId: revisionItem,
            kind: "static",
            qualityMode: "standard",
            edit: { rotation: 0, crop: null },
          },
        ],
        coverKey: null,
        coverCrop: null,
      },
      mediaItems: [test.client.items.get(revisionItem)!],
      conflict: null,
      deviceClass: "desktop",
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:00:00.000Z",
    });
    test.manager.addConfirmed([confirm("new", staticSource())]);
    await settle();
    const draftItem = test.item("new").itemId!;
    expect(test.transfer.starts).toHaveLength(1);

    test.manager.suspendForHolderChange();
    expect(test.transfer.transfer.abort).toHaveBeenCalledOnce();
    // The Backend deletes the draft: its own media goes, the work's media stays.
    await test.client.client.cancelItem(draftItem);
    const cancels = test.client.client.cancelItem.mock.calls.length;
    test.manager.bindSession({
      saveMode: "unsaved",
      resolveHolder: async () => ({ sessionId: SESSION_ID }),
    });
    await test.manager.detachFromHolder();
    await settle();
    expect(test.item("kept")).toMatchObject({
      phase: "ready",
      itemId: revisionItem,
    });
    expect(test.item("new").itemId).not.toBe(draftItem);
    expect(
      test.client.client.registerItem.mock.calls.at(-1)![0].holder,
    ).toEqual({ sessionId: SESSION_ID });
    expect(test.transfer.starts).toHaveLength(2);
    expect(test.manager.draftItems().map((item) => item.itemId)).toEqual([
      revisionItem,
      test.item("new").itemId,
    ]);
    // Detaching itself never cancels anything on the account.
    expect(test.client.client.cancelItem).toHaveBeenCalledTimes(cancels);
  });
});

describe("upload manager: clipboard provenance", () => {
  it("sends each item's selection source privately and marks clipboard items in the draft entries", async () => {
    const test = createTestManager();
    test.manager.addConfirmed([
      {
        ...confirm("pasted", staticSource()),
        notCameraOriginal: true,
        clientSource: "clipboard",
      },
      { ...confirm("dropped", staticSource()), clientSource: "drop" },
      confirm("legacy-literal", staticSource()),
    ]);
    await settle();
    const provenance = test.client.client.registerItem.mock.calls.map(
      ([command]) => command.metadata?.provenance,
    );
    expect(provenance).toEqual([
      expect.objectContaining({ status: "absent", clientSource: "clipboard" }),
      expect.objectContaining({ status: "absent", clientSource: "drop" }),
      expect.not.objectContaining({ clientSource: expect.anything() }),
    ]);
    expect(
      test.manager.draftItems().map((item) => [item.key, item.origin]),
    ).toEqual([
      ["pasted", "clipboard"],
      ["dropped", undefined],
      ["legacy-literal", undefined],
    ]);
    expect(test.item("pasted").notCameraOriginal).toBe(true);
  });

  it("records the provenance even when metadata extraction fails", async () => {
    const test = createTestManager({
      metadata: async () => {
        throw new Error("unreadable");
      },
    });
    test.manager.addConfirmed([
      {
        ...confirm("pasted", staticSource()),
        notCameraOriginal: true,
        clientSource: "clipboard",
      },
    ]);
    await settle();
    expect(test.client.client.registerItem.mock.calls[0]![0].metadata).toEqual({
      provenance: {
        source: "client",
        parser: "exifr@7.1.3",
        status: "absent",
        clientSource: "clipboard",
      },
      values: {},
    });
  });

  it("keeps the clipboard label of a restored draft item from its content origin", async () => {
    const test = createTestManager();
    await test.manager.restoreDraft({
      id: DRAFT_ID,
      kind: "new",
      workId: null,
      baseRevisionId: null,
      revision: 2,
      content: {
        title: "",
        body: "",
        authorship: { kind: "original" },
        visibility: "public",
        items: [
          {
            key: "pasted",
            itemId: null,
            kind: "static",
            qualityMode: "standard",
            edit: { rotation: 0, crop: null },
            pendingLabel: "photo",
            origin: "clipboard",
          },
          {
            key: "picked",
            itemId: null,
            kind: "static",
            qualityMode: "standard",
            edit: { rotation: 0, crop: null },
            pendingLabel: "photo",
          },
        ],
        coverKey: null,
        coverCrop: null,
      },
      mediaItems: [],
      conflict: null,
      deviceClass: "desktop",
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:00:00.000Z",
    });
    expect(
      test.manager
        .getSnapshot()
        .items.map((item) => [item.key, item.phase, item.notCameraOriginal]),
    ).toEqual([
      ["pasted", "missing_local", true],
      ["picked", "missing_local", false],
    ]);
    expect(test.manager.draftItems()).toEqual([
      {
        key: "pasted",
        itemId: null,
        kind: "static",
        qualityMode: "standard",
        pendingLabel: "photo",
        origin: "clipboard",
      },
      {
        key: "picked",
        itemId: null,
        kind: "static",
        qualityMode: "standard",
        pendingLabel: "photo",
      },
    ]);
  });
});
