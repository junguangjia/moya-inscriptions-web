// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { client, author } = vi.hoisted(() => ({
  client: { draft: vi.fn(), resolveConflict: vi.fn() },
  author: { notify: vi.fn() },
}));
vi.mock("../../publishing-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../publishing-data")>()),
  publishingClient: client,
}));
vi.mock("../../../authors/author-context", () => ({
  useAuthors: () => author,
}));

import { PublishingRequestError } from "../../publishing-data";
import { ConflictChooser } from "./conflict-chooser";
import {
  NOW,
  buttonByText,
  cleanup,
  click,
  conflict,
  content,
  draft,
  draftId,
  flush,
  installDialogPolyfill,
  itemId,
  readyItem,
  render,
} from "./drafts.test-support";

const item = (key: string, n: number | null) => ({
  key,
  itemId: n === null ? null : itemId(n),
  kind: "static" as const,
  qualityMode: "standard" as const,
  edit: { rotation: 0 as const, crop: null },
});

const version = (node: HTMLElement, choice: "device" | "account") =>
  node.querySelector<HTMLElement>(`[data-conflict-version="${choice}"]`)!;

const sample = conflict({
  device: {
    content: content({
      title: "手机上的标题",
      body: "手机正文\n第二行",
      items: [item("a", 1), item("b", 2), item("p", null)],
      coverKey: "b",
      visibility: "self",
    }),
    baseRevision: 2,
    deviceClass: "phone",
    savedAt: new Date(NOW.getTime() - 3 * 60_000).toISOString(),
  },
  account: {
    content: content({
      title: "电脑上的标题",
      body: "手机正文\n第二行",
      items: [item("b", 2), item("a", 1)],
      coverKey: null,
      authorship: {
        kind: "copy_practice",
        referenceTitle: "兰亭序",
        originalAuthor: "王羲之",
      },
    }),
    revision: 3,
    deviceClass: "desktop",
    updatedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
  },
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  installDialogPolyfill();
  window.history.replaceState({ kind: "editor" }, "", "/#editor");
  client.draft.mockResolvedValue(
    draft({ mediaItems: [readyItem(1), readyItem(2)] }),
  );
});
afterEach(async () => {
  window.history.replaceState({ kind: "editor" }, "", "/#editor");
  await cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Conflict chooser", () => {
  it("shows both versions side by side with text, media order, cover and settings", async () => {
    const node = await render(
      <ConflictChooser
        conflict={sample}
        draftId={draftId(1)}
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />,
    );
    await flush();
    const device = version(node, "device");
    const account = version(node, "account");
    expect(device.querySelector("h3")?.textContent).toBe("本设备版本");
    expect(account.querySelector("h3")?.textContent).toBe("账号中的新版本");
    expect(device.textContent).toContain("手机 · 3 分钟前保存");
    expect(account.textContent).toContain("电脑 · 5 分钟前更新");
    expect(device.textContent).toContain("手机上的标题");
    expect(account.textContent).toContain("电脑上的标题");
    expect(device.textContent).toContain("手机正文\n第二行");

    // Media order with numbers, the cover and pending items.
    const deviceTiles = Array.from(
      device.querySelectorAll("li[data-item-key]"),
    );
    expect(
      deviceTiles.map((tile) => tile.getAttribute("data-item-key")),
    ).toEqual(["a", "b", "p"]);
    expect(deviceTiles[1]?.hasAttribute("data-cover")).toBe(true);
    expect(deviceTiles[1]?.textContent).toContain("第 2 项，封面");
    expect(deviceTiles[0]?.querySelector("img")?.getAttribute("src")).toBe(
      readyItem(1).media!.thumbSrc,
    );
    expect(deviceTiles[2]?.textContent).toContain("待上传");
    const accountTiles = Array.from(
      account.querySelectorAll("li[data-item-key]"),
    );
    expect(
      accountTiles.map((tile) => tile.getAttribute("data-item-key")),
    ).toEqual(["b", "a"]);
    expect(account.querySelector("[data-cover]")).toBeNull();
    expect(client.draft).toHaveBeenCalledWith(
      draftId(1),
      expect.any(AbortSignal),
    );

    // Settings.
    expect(device.textContent).toContain("作品性质：原创");
    expect(device.textContent).toContain("可见范围：仅自己可见");
    expect(account.textContent).toContain("作品性质：临摹或练习");
    expect(account.textContent).toContain("参考作品：兰亭序");
    expect(account.textContent).toContain("原作者：王羲之");
    expect(account.textContent).toContain("可见范围：公开");

    // Differences are marked; the identical body is not.
    const differing = (scope: HTMLElement) =>
      Array.from(scope.querySelectorAll("dl[data-differs] dt")).map((dt) =>
        dt.firstChild?.textContent?.trim(),
      );
    expect(differing(device)).toEqual(["标题", "图片顺序（3 项）", "设置"]);
    expect(node.textContent).toContain("未选择的版本会保留在历史版本中");
  });

  it("says 未设置 for a version whose author declared no 作品性质", async () => {
    const node = await render(
      <ConflictChooser
        conflict={{
          ...sample,
          device: {
            ...sample.device,
            content: { ...sample.device.content, authorship: null },
          },
        }}
        draftId={draftId(1)}
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />,
    );
    await flush();
    const device = version(node, "device");
    expect(device.textContent).toContain("作品性质：未设置");
    expect(device.textContent).not.toContain("作品性质：原创");
    // Still a difference the chooser marks against the other version.
    expect(
      Array.from(device.querySelectorAll("dl[data-differs] dt")).map((dt) =>
        dt.firstChild?.textContent?.trim(),
      ),
    ).toContain("设置");
  });

  it("uses media the editor already has instead of reading the draft", async () => {
    const node = await render(
      <ConflictChooser
        conflict={sample}
        draftId={draftId(1)}
        mediaItems={[readyItem(2)]}
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />,
    );
    await flush();
    expect(client.draft).not.toHaveBeenCalled();
    const tiles = version(node, "device").querySelectorAll("li[data-item-key]");
    expect(tiles[0]?.textContent).toContain("不可用");
    expect(tiles[1]?.querySelector("img")).not.toBeNull();
  });

  it("resolves with the chosen version and says the other stays in history", async () => {
    const resolved = draft({ content: sample.device.content, revision: 4 });
    client.resolveConflict.mockResolvedValue(resolved);
    const onResolved = vi.fn();
    const node = await render(
      <ConflictChooser
        conflict={sample}
        draftId={draftId(1)}
        onClose={vi.fn()}
        onResolved={onResolved}
      />,
    );
    await flush();
    await click(buttonByText(version(node, "device"), "使用本设备版本"));
    await flush();
    expect(client.resolveConflict).toHaveBeenCalledExactlyOnceWith(draftId(1), {
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      conflictId: sample.id,
      choice: "device",
    });
    expect(onResolved).toHaveBeenCalledExactlyOnceWith(resolved);
    // The app-wide notice: the editor closes the chooser right away.
    expect(author.notify).toHaveBeenCalledExactlyOnceWith(
      "已使用本设备版本，账号中的新版本保留在历史版本中",
    );
  });

  it("can keep the account version instead", async () => {
    client.resolveConflict.mockResolvedValue(draft());
    const node = await render(
      <ConflictChooser
        conflict={sample}
        draftId={draftId(1)}
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />,
    );
    await flush();
    await click(buttonByText(version(node, "account"), "使用账号中的新版本"));
    await flush();
    expect(client.resolveConflict.mock.calls[0]?.[1]).toMatchObject({
      conflictId: sample.id,
      choice: "account",
    });
    expect(author.notify).toHaveBeenCalledExactlyOnceWith(
      "已使用账号中的新版本，本设备版本保留在历史版本中",
    );
  });

  it("hands back the account's draft when the conflict was settled elsewhere", async () => {
    client.resolveConflict.mockRejectedValue(
      new PublishingRequestError(409, "状态已变化，请检查后重试"),
    );
    const fresh = draft({ conflict: null, revision: 5 });
    client.draft.mockResolvedValue(fresh);
    const onResolved = vi.fn();
    const node = await render(
      <ConflictChooser
        conflict={sample}
        draftId={draftId(1)}
        mediaItems={[]}
        onClose={vi.fn()}
        onResolved={onResolved}
      />,
    );
    await click(buttonByText(version(node, "device"), "使用本设备版本"));
    await flush();
    expect(client.draft).toHaveBeenCalledOnce();
    expect(onResolved).toHaveBeenCalledExactlyOnceWith(fresh);
    expect(author.notify).toHaveBeenCalledExactlyOnceWith(
      "这份草稿的版本已经确定，将从账号中的最新内容继续编辑",
    );
    expect(node.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows a refusal while the conflict is still open and lets the author choose again", async () => {
    client.resolveConflict.mockRejectedValueOnce(
      new PublishingRequestError(422, "内容不符合要求，请检查后修改"),
    );
    client.draft.mockResolvedValue(draft({ conflict: sample }));
    const onResolved = vi.fn();
    const node = await render(
      <ConflictChooser
        conflict={sample}
        draftId={draftId(1)}
        mediaItems={[]}
        onClose={vi.fn()}
        onResolved={onResolved}
      />,
    );
    const device = buttonByText(version(node, "device"), "使用本设备版本");
    device.focus();
    await click(device);
    await flush();
    expect(onResolved).not.toHaveBeenCalled();
    expect(node.querySelector('[role="alert"]')?.textContent).toBe(
      "内容不符合要求，请检查后修改",
    );
    expect(document.activeElement).toBe(device);
    const account = buttonByText(
      version(node, "account"),
      "使用账号中的新版本",
    );
    expect(account.getAttribute("aria-disabled")).toBeNull();
    client.resolveConflict.mockResolvedValueOnce(draft());
    await click(account);
    await flush();
    expect(client.resolveConflict.mock.calls[1]?.[1]).toMatchObject({
      choice: "account",
    });
    expect(onResolved).toHaveBeenCalledOnce();
  });

  it("after an unconfirmed choice only that same choice can be sent again, with the same request", async () => {
    client.resolveConflict
      .mockRejectedValueOnce(
        new PublishingRequestError(0, "网络连接中断，结果尚未确认", null, true),
      )
      .mockResolvedValueOnce(draft());
    client.draft.mockResolvedValue(draft({ conflict: sample }));
    const node = await render(
      <ConflictChooser
        conflict={sample}
        draftId={draftId(1)}
        mediaItems={[]}
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />,
    );
    await click(buttonByText(version(node, "device"), "使用本设备版本"));
    await flush();
    const note = node.querySelector<HTMLElement>("[data-pending-choice]");
    expect(note?.textContent).toBe(
      "上一次选择的结果尚未确认，只能重试「使用本设备版本」",
    );
    const account = buttonByText(
      version(node, "account"),
      "使用账号中的新版本",
    );
    expect(account.getAttribute("aria-disabled")).toBe("true");
    expect(account.getAttribute("aria-describedby")).toContain(note!.id);
    await click(account);
    await flush();
    expect(client.resolveConflict).toHaveBeenCalledOnce();

    await click(buttonByText(version(node, "device"), "使用本设备版本"));
    await flush();
    const [first, second] = client.resolveConflict.mock.calls;
    expect(second?.[1]).toMatchObject({ choice: "device" });
    expect(second?.[1].requestId).toBe(first?.[1].requestId);
  });

  it("offers to check again when the draft cannot be read after a failure", async () => {
    client.resolveConflict.mockRejectedValue(
      new PublishingRequestError(409, "状态已变化，请检查后重试"),
    );
    client.draft.mockRejectedValueOnce(
      new PublishingRequestError(0, "网络连接中断，请检查后重试"),
    );
    const onResolved = vi.fn();
    const node = await render(
      <ConflictChooser
        conflict={sample}
        draftId={draftId(1)}
        mediaItems={[]}
        onClose={vi.fn()}
        onResolved={onResolved}
      />,
    );
    await click(buttonByText(version(node, "account"), "使用账号中的新版本"));
    await flush();
    const alert = node.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toContain("暂时无法确认草稿的当前状态");
    const fresh = draft({ conflict: null });
    client.draft.mockResolvedValueOnce(fresh);
    await click(buttonByText(alert, "重新检查"));
    await flush();
    expect(onResolved).toHaveBeenCalledExactlyOnceWith(fresh);
  });

  it("says thumbnails could not be read instead of calling items unavailable", async () => {
    client.draft.mockRejectedValue(
      new PublishingRequestError(0, "网络连接中断，请检查后重试"),
    );
    const node = await render(
      <ConflictChooser
        conflict={sample}
        draftId={draftId(1)}
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />,
    );
    await flush();
    expect(node.querySelector("[data-thumbs-failed]")?.textContent).toContain(
      "缩略图暂时无法读取",
    );
    expect(node.textContent).not.toContain("不可用");
    const tiles = version(node, "device").querySelectorAll("li[data-item-key]");
    expect(tiles[2]?.textContent).toContain("待上传");
  });

  it("names rotations and crops the unedited thumbnails cannot show", async () => {
    const edited = conflict({
      device: {
        ...sample.device,
        content: content({
          items: [
            {
              ...item("a", 1),
              edit: {
                rotation: 90,
                crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
              },
            },
            item("b", 2),
          ],
          coverKey: "b",
          coverCrop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        }),
      },
      account: {
        ...sample.account,
        content: content({
          items: [item("a", 1), item("b", 2)],
          coverKey: "b",
        }),
      },
    });
    const node = await render(
      <ConflictChooser
        conflict={edited}
        draftId={draftId(1)}
        mediaItems={[readyItem(1), readyItem(2)]}
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />,
    );
    const device = version(node, "device");
    expect(device.querySelector("[data-edit-notes]")?.textContent).toBe(
      "第 1 项已旋转 90°、已裁剪；封面已裁剪",
    );
    expect(device.querySelector("li[data-item-key]")?.textContent).toContain(
      "第 1 项，已旋转 90°、已裁剪",
    );
    expect(
      version(node, "account").querySelector("[data-edit-notes]"),
    ).toBeNull();
    expect(device.querySelector("dl[data-differs] dt")?.textContent).toContain(
      "图片顺序",
    );
  });

  it("names the feed framing that makes two albums differ (#341)", async () => {
    const framed = conflict({
      device: {
        ...sample.device,
        content: content({
          items: [
            {
              ...item("a", 1),
              edit: { ...item("a", 1).edit, feed: { fit: "contain" } },
            },
            item("b", 2),
          ],
          coverKey: "a",
        }),
      },
      account: {
        ...sample.account,
        content: content({
          items: [
            {
              ...item("a", 1),
              edit: { ...item("a", 1).edit, feed: { fit: "cover", y: 0.5 } },
            },
            item("b", 2),
          ],
          coverKey: "a",
        }),
      },
    });
    const node = await render(
      <ConflictChooser
        conflict={framed}
        draftId={draftId(1)}
        mediaItems={[readyItem(1), readyItem(2)]}
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />,
    );
    const device = version(node, "device");
    const account = version(node, "account");
    // Only the framing differs, and the version that has one says so.
    expect(device.querySelector("dl[data-differs] dt")?.textContent).toContain(
      "图片顺序（2 项）与另一版本不同",
    );
    expect(device.querySelector("[data-edit-notes]")?.textContent).toBe(
      "第 1 项动态流整张显示",
    );
    expect(device.querySelector("li[data-item-key]")?.textContent).toContain(
      "第 1 项，封面，动态流整张显示",
    );
    // A centred cover is no framing: nothing to name.
    expect(account.querySelector("[data-edit-notes]")).toBeNull();
  });
});
