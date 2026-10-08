// @vitest-environment jsdom
import { act, createRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { AuthorProfile } from "@moya/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./local-library", () => ({
  readGuestFavorites: async () => [],
  pendingGuestBatch: async () => null,
  hasOtherGuestBatch: async () => false,
  contentKey: vi.fn(),
  acknowledgeGuestBatch: vi.fn(),
  setGuestFavorite: vi.fn(),
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({ platform: "phone" }),
}));
vi.mock("../shell/horizontal-pager", () => ({ HorizontalPager: () => null }));
vi.mock("./profile-list", () => ({ ProfileList: () => null }));
vi.mock("./avatar-image", () => ({
  readAvatarImage: async () => ({
    pixels: {},
    url: "blob:synthetic-avatar",
    release: () => undefined,
  }),
  exportAvatarSnapshot: () => "data:image/png;base64,c3ludGhldGlj",
}));
vi.mock("react-easy-crop", async () => {
  const { useEffect } = await import("react");
  return {
    default: ({
      onCropAreaChange,
    }: {
      onCropAreaChange: (area: object, pixels: object) => void;
    }) => {
      useEffect(
        () => onCropAreaChange({}, { x: 0, y: 0, width: 600, height: 600 }),
        [],
      );
      return <div data-real-session-crop="" />;
    },
  };
});
import { AuthorProvider, useAuthors } from "./author-context";
import { authorClient } from "./author-data";
import { AvatarEditor } from "./avatar-editor";
import { AuthorProfileOverlay } from "./author-profile";
import { profileHistoryState } from "../product-shell/product-history";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const owner = {
  id: "user-00000000000000000000000000000001",
  handle: "synthetic-avatar-session-a",
  displayName: "甲",
};
const other = {
  id: "user-00000000000000000000000000000002",
  handle: "synthetic-avatar-session-b",
  displayName: "乙",
};
const media = {
  id: "user-media-00000000000000000000000000000001",
  src: "/api/community/media/user-media-00000000000000000000000000000001",
  width: 512,
  height: 512,
};
const profile: AuthorProfile = {
  ...owner,
  bio: "",
  avatar: null,
  isOwner: true,
  following: false,
  nextAvatarChangeAt: null,
  privacy: {
    following: "private",
    followers: "private",
    favorites: "private",
    likes: "private",
  },
  totals: { works: 0, following: 0, followers: 0, favorites: 0, likes: 0 },
};
const photo = new File(["synthetic jpg"], "photo.jpg", { type: "image/jpeg" });
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const deferred = () => {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let root: Root, node: HTMLDivElement;
let me: () => Promise<Response>,
  upload: () => Promise<Response>,
  bind: () => Promise<Response>,
  bound: boolean;
let readProfile: () => Promise<Response>;
const closed = vi.fn(),
  requests: { path: string; init: RequestInit }[] = [];
const Harness = () => {
  const author = useAuthors();
  const [open, setOpen] = useState(true);
  return (
    <>
      <output
        data-shared-avatar={author.avatarSrc ?? ""}
        data-viewer-studio={author.viewer?.studioName ?? ""}
      />
      {author.viewer?.id === owner.id && open && (
        <AvatarEditor
          profile={profile}
          file={photo}
          onClose={() => {
            closed();
            setOpen(false);
          }}
        />
      )}
    </>
  );
};
beforeEach(async () => {
  vi.clearAllMocks();
  requests.length = 0;
  window.localStorage.clear();
  bound = false;
  readProfile = async () => reply({ ...profile, avatar: bound ? media : null });
  me = async () => reply(owner);
  upload = async () => reply(media);
  bind = async () => {
    bound = true;
    return reply({ nextChangeAt: "2099-01-01T05:00:00Z" });
  };
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      requests.push({ path: input, init });
      if (input === "/api/community/me") return me();
      if (input.startsWith("/api/community/authors/")) return readProfile();
      if (input === "/api/community/media") return upload();
      if (input === "/api/community/me/avatar") return bind();
      throw Error(`Unexpected request: ${input}`);
    }),
  );
  window.history.replaceState({}, "", "/#profile");
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root.render(
      <AuthorProvider signInHref="/dev/community">
        <Harness />
      </AuthorProvider>,
    ),
  );
});
afterEach(async () => {
  window.history.replaceState({}, "", "/#profile");
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const button = (text: string) =>
  Array.from(node.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  )!;
const click = async (text = "保存头像") =>
  act(async () => button(text).click());
const focus = async () =>
  act(async () => window.dispatchEvent(new Event("focus")));
const posts = (suffix: string) =>
  requests.filter((r) => r.path.endsWith(suffix) && r.init.method === "POST");

it("waits for same-owner picker focus refresh, then saves and refreshes shared avatar", async () => {
  const check = deferred();
  me = () => check.promise;
  await focus();
  expect(authorClient.account()).toBe(owner.id);
  expect(button("保存头像").disabled).toBe(true);
  await click();
  expect(posts("/media")).toHaveLength(0);
  await act(async () => check.resolve(reply(owner)));
  await click();
  expect(closed).toHaveBeenCalledOnce();
  expect(node.querySelector("output")?.getAttribute("data-shared-avatar")).toBe(
    media.src,
  );
});
it.each(["upload", "bind"])(
  "does not discard a successful %s during same-owner focus refresh",
  async (phase) => {
    const check = deferred(),
      write = deferred();
    if (phase === "upload") upload = () => write.promise;
    else bind = () => write.promise;
    await click();
    me = () => check.promise;
    await focus();
    expect(authorClient.account()).toBe(owner.id);
    await act(async () => {
      if (phase === "bind") bound = true;
      write.resolve(
        reply(
          phase === "upload" ? media : { nextChangeAt: "2099-01-01T05:00:00Z" },
        ),
      );
    });
    expect(closed).toHaveBeenCalledOnce();
    await act(async () => check.resolve(reply(owner)));
    expect(
      node.querySelector("output")?.getAttribute("data-shared-avatar"),
    ).toBe(media.src);
  },
);
it.each(["switch", "logout"])(
  "invalidates an old upload after a confirmed %s and never binds it",
  async (phase) => {
    const write = deferred();
    upload = () => write.promise;
    await click();
    me = async () =>
      phase === "switch"
        ? reply(other)
        : reply(
            { error: { code: "UNAUTHENTICATED", message: "signed out" } },
            401,
          );
    await focus();
    expect(authorClient.account()).toBe(phase === "switch" ? other.id : null);
    await act(async () => write.resolve(reply(media)));
    expect(posts("/me/avatar")).toHaveLength(0);
  },
);
it("retains crop and explicitly reconfirms after a failed session check", async () => {
  me = async () => reply({}, 503);
  await focus();
  expect(authorClient.account()).toBeNull();
  expect(button("保存头像").disabled).toBe(true);
  expect(node.querySelector("[data-real-session-crop]")).not.toBeNull();
  me = async () => reply(owner);
  await click("重新确认账户");
  await click();
});
it("automatically resumes the accepted binding identity after a concurrent refresh failure", async () => {
  const accepted = deferred();
  bind = () => accepted.promise;
  await click();
  bound = true;
  me = async () => reply({}, 503);
  await focus();
  await act(async () =>
    accepted.resolve(reply({ nextChangeAt: "2099-01-01T05:00:00Z" })),
  );
  expect(node.querySelector("dialog")).toBeNull();
  expect(node.textContent).toContain("等待网络恢复");
  me = async () => reply(owner);
  bind = async () => reply({ nextChangeAt: "2099-01-01T05:00:00Z" });
  await focus();
  expect(posts("/media")).toHaveLength(1);
  expect(posts("/me/avatar")).toHaveLength(2);
  expect(posts("/me/avatar")[1]?.init.body).toBe(
    posts("/me/avatar")[0]?.init.body,
  );
  expect(node.querySelector("output")?.getAttribute("data-shared-avatar")).toBe(
    media.src,
  );
});

it.each(["upload", "bind"])(
  "restores a Save after full provider unmount/reload during %s",
  async (phase) => {
    const interrupted = deferred();
    if (phase === "upload") upload = () => interrupted.promise;
    else bind = () => interrupted.promise;
    await click();
    const firstUpload = posts("/media")[0]!.init.headers;
    const firstBind = posts("/me/avatar")[0]?.init.body;
    const stored = localStorage.getItem(`yoyi-avatar-save-v1:${owner.id}`);
    expect(stored).toContain("data:image/png;base64,");
    expect(closed).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    upload = async () => reply(media);
    bind = async () => {
      bound = true;
      return reply({ nextChangeAt: "2099-01-01T05:00:00Z" });
    };
    root = createRoot(node);
    await act(async () =>
      root.render(
        <AuthorProvider signInHref="/dev/community">
          <output data-reloaded="" />
        </AuthorProvider>,
      ),
    );
    expect(node.textContent).toContain("头像已更换");
    expect(localStorage.getItem(`yoyi-avatar-save-v1:${owner.id}`)).toBeNull();
    if (phase === "upload")
      expect(posts("/media")[1]?.init.headers).toEqual(firstUpload);
    else {
      expect(posts("/media")).toHaveLength(1);
      expect(posts("/me/avatar")[1]?.init.body).toEqual(firstBind);
    }
    await act(async () =>
      interrupted.resolve(
        reply(
          phase === "upload" ? media : { nextChangeAt: "2099-01-01T05:00:00Z" },
        ),
      ),
    );
  },
);

it("records a real daily-limit rejection without retrying into another day or losing pending image", async () => {
  bind = async () => reply({ error: { message: "daily limit" } }, 409);
  readProfile = async () =>
    reply({ ...profile, nextAvatarChangeAt: "2099-01-02T05:00:00Z" });
  await click();
  expect(node.textContent).toContain("2099年1月2日");
  const intent = localStorage.getItem(`yoyi-avatar-save-v1:${owner.id}`)!;
  expect(intent).toContain("data:image/png;base64,");
  await focus();
  expect(posts("/me/avatar")).toHaveLength(1);
});

it("keeps the actual profile and crop when an obsolete profile read rejects after refresh failure", async () => {
  window.history.replaceState({}, "", "/#profile");
  await act(async () =>
    root.render(
      <AuthorProvider signInHref="/dev/community">
        <AuthorProfileOverlay
          state={profileHistoryState(
            owner.id,
            "avatar-session-test",
            "works",
            0,
            "home",
            0,
          )}
          backButtonRef={createRef<HTMLButtonElement>()}
          onClose={vi.fn()}
          onViewChange={vi.fn()}
        />
      </AuthorProvider>,
    ),
  );
  const input = node.querySelector<HTMLInputElement>(
    'input[aria-label="选择头像照片"]',
  )!;
  expect(input).not.toBeNull();
  Object.defineProperty(input, "files", { value: [photo] });
  await act(async () =>
    input.dispatchEvent(new Event("change", { bubbles: true })),
  );
  expect(node.querySelector("[data-real-session-crop]")).not.toBeNull();
  const stale = deferred();
  readProfile = () => stale.promise.then((response) => response.clone());
  await focus();
  me = async () => reply({}, 503);
  await focus();
  await act(async () => stale.resolve(reply(profile)));
  expect(node.querySelector("[data-real-session-crop]")).not.toBeNull();
  expect(button("重新确认账户").disabled).toBe(false);
  expect(button("保存头像").disabled).toBe(true);
  readProfile = async () => reply(profile);
  me = async () => reply(owner);
  await click("重新确认账户");
  expect(button("保存头像").disabled).toBe(false);
});

it("resumes a pending offline reload on online without focus, and rearms failed revalidation", async () => {
  const interrupted = deferred();
  upload = () => interrupted.promise;
  await click();
  await act(async () => root.unmount());
  root = createRoot(node);
  vi.useFakeTimers();
  me = async () => reply({}, 503);
  await act(async () =>
    root.render(
      <AuthorProvider signInHref="/dev/community">
        <output />
      </AuthorProvider>,
    ),
  );
  const before = requests.filter((r) => r.path === "/api/community/me").length;
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(
    requests.filter((r) => r.path === "/api/community/me").length,
  ).toBeGreaterThan(before);
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(
    requests.filter((r) => r.path === "/api/community/me").length,
  ).toBeGreaterThan(before + 1);
  upload = async () => reply(media);
  me = async () => reply(owner);
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(node.textContent).toContain("头像已更换");
  expect(localStorage.getItem(`yoyi-avatar-save-v1:${owner.id}`)).toBeNull();
  await act(async () => interrupted.resolve(reply(media)));
  vi.useRealTimers();
});

it("does not overwrite another tab's replacement intent after a delayed conflict reconciliation", async () => {
  const conflictProfile = deferred(),
    replacementUpload = deferred();
  bind = async () => reply({ error: { message: "daily limit" } }, 409);
  readProfile = () => conflictProfile.promise.then((r) => r.clone());
  await click();
  const storageKey = `yoyi-avatar-save-v1:${owner.id}`;
  const first = JSON.parse(localStorage.getItem(storageKey)!);
  const replacement = {
    ...first,
    uploadId: "00000000-0000-4000-8000-000000000002",
    saveId: "00000000-0000-4000-8000-000000000003",
    png: "data:image/png;base64,bmV3",
  };
  delete replacement.mediaId;
  localStorage.setItem(storageKey, JSON.stringify(replacement));
  upload = () => replacementUpload.promise;
  await act(async () =>
    window.dispatchEvent(new StorageEvent("storage", { key: storageKey })),
  );
  await act(async () =>
    conflictProfile.resolve(
      reply({ ...profile, nextAvatarChangeAt: "2099-01-02T05:00:00Z" }),
    ),
  );
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(replacement);
  expect(posts("/media").at(-1)?.init.headers).toMatchObject({
    "x-request-id": replacement.uploadId,
  });
  expect(node.textContent).not.toContain("今天已更换");
  bind = async () => {
    bound = true;
    return reply({ nextChangeAt: "2099-01-02T05:00:00Z" });
  };
  readProfile = async () => reply({ ...profile, avatar: media });
  await act(async () => replacementUpload.resolve(reply(media)));
});

it("rearms account confirmation when a conflict reconciliation overlaps a failed session refresh", async () => {
  const reconciliation = deferred();
  bind = async () => reply({ error: { message: "conflict" } }, 409);
  readProfile = () => reconciliation.promise.then((r) => r.clone());
  await click();
  me = async () => reply({}, 503);
  await focus();
  vi.useFakeTimers();
  await act(async () => reconciliation.resolve(reply(profile)));
  const before = requests.filter((r) => r.path === "/api/community/me").length;
  me = async () => reply(owner);
  bind = async () => {
    bound = true;
    return reply({ nextChangeAt: "2099-01-01T05:00:00Z" });
  };
  readProfile = async () => reply({ ...profile, avatar: media });
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(
    requests.filter((r) => r.path === "/api/community/me").length,
  ).toBeGreaterThan(before);
  expect(localStorage.getItem(`yoyi-avatar-save-v1:${owner.id}`)).toBeNull();
  expect(node.textContent).toContain("头像已更换");
  vi.useRealTimers();
});

it("retries a definitive upload rejection with the retained crop and request IDs", async () => {
  upload = async () => reply({}, 422);
  await click();
  expect(node.textContent).toContain("服务器未接受图像");
  const first = posts("/media")[0]!.init.headers;
  upload = async () => reply(media);
  await click("重试保存");
  expect(posts("/media")[1]!.init.headers).toEqual(first);
  expect(node.textContent).toContain("头像已更换");
});

it("refreshes viewer identity when only the studio name changes", async () => {
  me = async () => reply({ ...owner, studioName: "听雨斋" });
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(
    node
      .querySelector("[data-viewer-studio]")
      ?.getAttribute("data-viewer-studio"),
  ).toBe("听雨斋");
});
