// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { submit, createUploads } = vi.hoisted(() => ({
  submit: vi.fn(),
  createUploads: vi.fn(),
}));
vi.mock("../../lib/public-api/feedback-client", () => ({
  feedbackClient: { submit },
  feedbackImageLimits: { maxImages: 3, maxBytes: 10 * 1024 * 1024 },
}));
vi.mock("./feedback-upload-session", () => ({
  createFeedbackUploadSession: createUploads,
  FeedbackImageError: class extends Error {},
}));
vi.mock("../publishing/ui/media/media-preview", () => ({
  useBoundedPreview: () => ({ status: "ready", url: null, size: null }),
}));
import { FeedbackImageError } from "./feedback-upload-session";
import type {
  UploadManagerSnapshot,
  UploadItemView,
} from "../publishing/upload-manager";
import { SettingsFeedbackForm, useSettingsFeedback } from "./feedback-form";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let node: HTMLDivElement;
let feedback: ReturnType<typeof useSettingsFeedback>;
const owner = "user-00000000000000000000000000000001";
const Harness = ({ account }: { account: string | null }) => {
  feedback = useSettingsFeedback(account);
  return <SettingsFeedbackForm feedback={feedback} />;
};
const render = async (account: string | null = owner) =>
  act(async () => root.render(<Harness account={account} />));
const input = async (message: string) =>
  act(async () => feedback.setMessage(message));
const send = async () =>
  act(async () => {
    await feedback.submit();
  });
beforeEach(async () => {
  vi.clearAllMocks();
  createUploads.mockImplementation((account: string) => makeUploads(account));
  submit.mockResolvedValue({
    id: "feedback-00000000000000000000000000000001",
    createdAt: "2026-10-23T12:00:00.000Z",
  });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});
describe("settings feedback", () => {
  it("rejects whitespace and oversize before submission", async () => {
    await input(" \n ");
    await send();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(
      "请填写",
    );
    await input("字".repeat(5001));
    await send();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("5000");
    expect(submit).not.toHaveBeenCalled();
  });
  it("waits for the backend and synchronously blocks duplicate submissions", async () => {
    let resolve!: (value: unknown) => void;
    submit.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await input("  搜索建议  ");
    let first!: Promise<void>;
    await act(async () => {
      first = feedback.submit();
      void feedback.submit();
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ message: "搜索建议" });
    expect(node.querySelector("button")?.disabled).toBe(true);
    expect(node.textContent).not.toContain("反馈已提交");
    await act(async () => {
      resolve({
        id: "feedback-00000000000000000000000000000001",
        createdAt: "2026-10-23T12:00:00.000Z",
      });
      await first;
    });
    expect(feedback.message).toBe("");
    expect(feedback.dirty).toBe(false);
    expect(node.textContent).toContain("反馈已提交");
  });
  it("retains failed drafts and reuses the same key for a retry", async () => {
    submit.mockRejectedValueOnce(new Error("timeout"));
    await input("保留这条建议");
    await send();
    const key = submit.mock.calls[0]?.[0].submissionId;
    expect(feedback.message).toBe("保留这条建议");
    expect(feedback.dirty).toBe(true);
    expect(node.querySelector('[role="alert"]')).not.toBeNull();
    await send();
    expect(submit.mock.calls[1]?.[0].submissionId).toBe(key);
    expect(node.textContent).toContain("反馈已提交");
  });
  it("uses a new key when the user edits a failed message", async () => {
    submit.mockRejectedValueOnce(new Error("timeout"));
    await input("第一条");
    await send();
    const key = submit.mock.calls[0]?.[0].submissionId;
    await input("修订内容");
    await send();
    expect(submit.mock.calls[1]?.[0].submissionId).not.toBe(key);
  });
  it("clears private state on account change and ignores a late result", async () => {
    let resolve!: (value: unknown) => void;
    submit.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await input("账户 A 的反馈");
    let first!: Promise<void>;
    await act(async () => {
      first = feedback.submit();
    });
    const signal = submit.mock.calls[0]?.[1] as AbortSignal;
    await render("user-00000000000000000000000000000002");
    expect(signal.aborted).toBe(true);
    expect(feedback.message).toBe("");
    await act(async () => {
      resolve({});
      await first;
    });
    expect(node.textContent).not.toContain("反馈已提交");
    expect(feedback.pending).toBe(false);
  });
  it("clears logout drafts and refuses a guest submission", async () => {
    await input("账户私密草稿");
    await render(null);
    await send();
    expect(feedback.message).toBe("");
    expect(submit).not.toHaveBeenCalled();
  });
});

const imageView = (
  key: string,
  phase: UploadItemView["phase"] = "processing",
  itemId: string | null = null,
): UploadItemView => ({
  key,
  kind: "static",
  qualityMode: "standard",
  notCameraOriginal: false,
  phase,
  itemId,
  components: [],
  failure: null,
  choice: null,
  recoverable: false,
  serverItem: null,
});
const makeUploads = (account: string) => {
  const listeners = new Set<() => void>();
  let state: UploadManagerSnapshot = {
    accountId: account,
    status: "active",
    pauseReason: null,
    items: [],
  };
  const files = new Map<string, Blob>();
  const publish = (
    items: readonly UploadItemView[],
    status: UploadManagerSnapshot["status"] = state.status,
  ) => {
    state = {
      ...state,
      items,
      status,
      pauseReason: status === "paused" ? "offline" : null,
    };
    for (const listener of listeners) listener();
  };
  return {
    owner: account,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => state,
    localStill: (key: string) => files.get(key) ?? null,
    publish,
    add: vi.fn(async (selected: readonly File[]) => {
      const items = [...state.items];
      for (const file of selected) {
        const key = `image-${items.length + 1}`;
        files.set(key, file);
        items.push(imageView(key));
      }
      publish(items);
    }),
    remove: vi.fn(async (key: string) => {
      files.delete(key);
      publish(state.items.filter((item) => item.key !== key));
    }),
    retry: vi.fn(async () => undefined),
    resumeConnection: vi.fn(async () => {
      publish(state.items, "active");
    }),
    committed: vi.fn(async () => undefined),
    abandon: vi.fn(async () => undefined),
  };
};
const selectImage = async () =>
  act(async () =>
    feedback.addImages([
      new File(["synthetic"], "screenshot.png", { type: "image/png" }),
    ]),
  );
const uploads = () =>
  createUploads.mock.results.at(-1)!.value as ReturnType<typeof makeUploads>;
const readyImages = async (...ids: string[]) =>
  act(async () =>
    uploads().publish(
      ids.map((id, index) => imageView(`image-${index + 1}`, "ready", id)),
    ),
  );
const imageId = (value: string) => `media-item-${value.repeat(32)}`;

describe("optional feedback images", () => {
  it("does not start an upload session for text-only feedback", async () => {
    await input("纯文字建议");
    await send();
    expect(createUploads).not.toHaveBeenCalled();
  });
  it("keeps image-only drafts dirty, still requires text and waits for readiness", async () => {
    await selectImage();
    expect(feedback.dirty).toBe(true);
    expect(feedback.images).toHaveLength(1);
    await send();
    expect(submit).not.toHaveBeenCalled();
    await input("页面截图");
    await send();
    expect(submit).not.toHaveBeenCalled();
    expect(feedback.pending).toBe(false);
    expect(feedback.imageError).toContain("请等待");
    const session = uploads();
    await readyImages(imageId("a"));
    await send();
    expect(submit.mock.calls[0]?.[0].imageIds).toEqual([imageId("a")]);
    expect(feedback.images).toHaveLength(0);
    expect(feedback.dirty).toBe(false);
    expect(session.committed).toHaveBeenCalledOnce();
  });
  it("retains files and ordered ids after a lost save response and retries the same intent", async () => {
    await selectImage();
    await selectImage();
    await readyImages(imageId("a"), imageId("b"));
    await input("截图说明");
    submit.mockRejectedValueOnce(new Error("lost feedback response"));
    await send();
    const original = submit.mock.calls[0]?.[0];
    expect(feedback.images).toHaveLength(2);
    expect(feedback.localStill("image-1")).toBeInstanceOf(Blob);
    expect(uploads().committed).not.toHaveBeenCalled();
    await send();
    expect(submit.mock.calls[1]?.[0]).toEqual(original);
  });
  it("changes the idempotency intent after removing an image from a failed submission", async () => {
    await selectImage();
    await readyImages(imageId("a"));
    await input("保留正文");
    submit.mockRejectedValueOnce(new Error("lost feedback response"));
    await send();
    const oldKey = submit.mock.calls[0]?.[0].submissionId;
    await act(async () => feedback.removeImage("image-1"));
    expect(feedback.message).toBe("保留正文");
    expect(feedback.images).toHaveLength(0);
    await send();
    expect(submit.mock.calls[1]?.[0].submissionId).not.toBe(oldKey);
    expect(submit.mock.calls[1]?.[0].imageIds).toBeUndefined();
  });
  it("recovers a failed selection without leaving controls busy and exposes image retry/removal", async () => {
    await input("保留文字");
    const session = makeUploads(owner);
    session.add.mockRejectedValueOnce(new FeedbackImageError("图片过大"));
    createUploads.mockReturnValueOnce(session);
    await selectImage();
    expect(feedback.selecting).toBe(false);
    expect(feedback.pending).toBe(false);
    expect(feedback.message).toBe("保留文字");
    expect(feedback.imageError).toBe("图片过大");
    await selectImage();
    await act(async () => session.publish([imageView("image-1", "failed")]));
    await act(async () => feedback.retryImage("image-1"));
    expect(session.retry).toHaveBeenCalledWith("image-1");
    await act(async () => feedback.removeImage("image-1"));
    expect(session.remove).toHaveBeenCalledWith("image-1");
    expect(feedback.images).toHaveLength(0);
  });
  it("shows safe product text instead of internal upload errors", async () => {
    const session = makeUploads(owner);
    session.add.mockRejectedValueOnce(
      new Error("synthetic_internal_upload_failure"),
    );
    createUploads.mockReturnValueOnce(session);
    await selectImage();
    expect(feedback.imageError).toBe("图片暂时无法添加，请重试。");
    expect(node.textContent).not.toContain("synthetic_internal_upload_failure");
  });
  it("retains ready pictures and text while an explicit connection retry fails then succeeds", async () => {
    await selectImage();
    await readyImages(imageId("a"));
    await input("保留截图说明");
    const session = uploads();
    await act(async () => session.publish(session.snapshot().items, "paused"));
    expect(feedback.connectionPaused).toBe(true);
    expect(node.textContent).toContain("重试图片连接");
    session.resumeConnection.mockRejectedValueOnce(
      new FeedbackImageError("图片连接暂时无法恢复，请重试。"),
    );
    await act(async () => feedback.retryConnection());
    expect(feedback.reconnecting).toBe(false);
    expect(feedback.message).toBe("保留截图说明");
    expect(feedback.images[0]?.itemId).toBe(imageId("a"));
    expect(feedback.imageError).toContain("图片连接暂时无法恢复");
    await act(async () => feedback.retryConnection());
    expect(feedback.connectionPaused).toBe(false);
    expect(feedback.images[0]?.itemId).toBe(imageId("a"));
    expect(createUploads).toHaveBeenCalledOnce();
  });
  it("still replays an already-saved feedback intent while its ready-image connection is paused", async () => {
    await selectImage();
    await readyImages(imageId("a"));
    await input("已保存但响应丢失");
    submit.mockRejectedValueOnce(new Error("lost feedback receipt"));
    await send();
    const original = submit.mock.calls[0]?.[0];
    const session = uploads();
    await act(async () => session.publish(session.snapshot().items, "paused"));
    expect(feedback.imagesBusy).toBe(false);
    await send();
    expect(submit.mock.calls[1]?.[0]).toEqual(original);
    expect(session.resumeConnection).not.toHaveBeenCalled();
    expect(feedback.sent).toBe(true);
  });
  it("allows fresh selection after explicitly removing the last image during connection recovery", async () => {
    await selectImage();
    await readyImages(imageId("a"));
    const old = uploads();
    await act(async () => old.publish(old.snapshot().items, "paused"));
    let resolve!: () => void;
    old.resumeConnection.mockReturnValueOnce(
      new Promise<undefined>((done) => {
        resolve = () => done(undefined);
      }),
    );
    let retry!: Promise<void>;
    await act(async () => {
      retry = feedback.retryConnection();
    });
    expect(feedback.reconnecting).toBe(true);
    await act(async () => feedback.removeImage("image-1"));
    expect(feedback.reconnecting).toBe(false);
    await selectImage();
    expect(createUploads).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolve();
      await retry;
    });
    expect(feedback.images).toHaveLength(1);
    expect(old.abandon).toHaveBeenCalledOnce();
  });
  it("abandons uploads and hides private image state on account change", async () => {
    await selectImage();
    const old = uploads();
    await render("user-00000000000000000000000000000002");
    expect(old.abandon).toHaveBeenCalledOnce();
    expect(feedback.images).toHaveLength(0);
    expect(feedback.localStill("image-1")).toBeNull();
  });
});
