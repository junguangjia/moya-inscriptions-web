// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./local-library", () => ({
  readGuestFavorites: async () => [],
  pendingGuestBatch: async () => null,
  hasOtherGuestBatch: async () => false,
  contentKey: vi.fn(),
  acknowledgeGuestBatch: vi.fn(),
  setGuestFavorite: vi.fn(),
}));
import { AuthorProvider, useAuthors } from "./author-context";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// account-deletion-v1: a pending deletion holds the provider's Session
// rechecks. Synthetic account only; no Session or Backend is used.
const owner = {
  id: "user-00000000000000000000000000000001",
  handle: "synthetic-session-hold",
  displayName: "甲",
};
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const signedOut = () =>
  reply({ error: { code: "UNAUTHENTICATED", message: "请先登录" } }, 401);
let root: Root, node: HTMLDivElement;
let me: () => Promise<Response>;
let avatar: () => Promise<Response>;
const requests: string[] = [];
let author: ReturnType<typeof useAuthors>;
const Probe = () => {
  author = useAuthors();
  return <output data-viewer={author.viewer?.id ?? ""} />;
};
const viewer = () =>
  node.querySelector("output")?.getAttribute("data-viewer") ?? "";
const checks = () =>
  requests.filter((path) => path === "/api/community/me").length;
const profileReads = () =>
  requests.filter((path) => path.startsWith("/api/community/authors/")).length;
const avatarSaves = () =>
  requests.filter((path) => path === "/api/community/me/avatar").length;
const focus = async () =>
  act(async () => window.dispatchEvent(new Event("focus")));

beforeEach(async () => {
  requests.length = 0;
  window.localStorage.clear();
  me = async () => reply(owner);
  avatar = async () => reply({ nextChangeAt: "2026-10-27T01:00:00.000Z" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      requests.push(input);
      if (input === "/api/community/me") return me();
      if (input === "/api/community/me/avatar") return avatar();
      if (input.startsWith("/api/community/authors/"))
        return reply({ error: { code: "NOT_FOUND", message: "x" } }, 404);
      throw Error(`Unexpected request: ${input}`);
    }),
  );
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root.render(
      <AuthorProvider signInHref="/dev/community">
        <Probe />
      </AuthorProvider>,
    ),
  );
  expect(viewer()).toBe(owner.id);
  expect(checks()).toBe(1);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("held Session rechecks", () => {
  it("waits while any hold remains, then rechecks once", async () => {
    me = async () => signedOut();
    const first = author.holdSession();
    const second = author.holdSession();
    await focus();
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
      await author.refresh();
    });
    expect(checks()).toBe(1);
    expect(viewer()).toBe(owner.id);
    await act(async () => {
      first();
      first();
    });
    expect(checks()).toBe(1);
    expect(viewer()).toBe(owner.id);
    await act(async () => second());
    expect(checks()).toBe(2);
    expect(viewer()).toBe("");
  });

  it("drops the answer of a recheck already under way when the hold starts", async () => {
    let answer: (value: Response) => void = () => {};
    me = () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      });
    await focus();
    expect(checks()).toBe(2);
    const release = author.holdSession();
    await act(async () => answer(signedOut()));
    expect(viewer()).toBe(owner.id);
    me = async () => signedOut();
    await act(async () => release());
    expect(checks()).toBe(3);
    expect(viewer()).toBe("");
  });

  it("rechecks nothing on release when nothing waited", async () => {
    const release = author.holdSession();
    await act(async () => release());
    expect(checks()).toBe(1);
    expect(viewer()).toBe(owner.id);
  });

  it("defers revision changes, and so every profile reread, until released", async () => {
    const revision = author.revision;
    const reads = profileReads();
    const release = author.holdSession();
    await act(async () => {
      author.mutate();
      author.mutate();
    });
    // The open profile would reread with the held Session and, refused,
    // re-key its settings (and the deletion page) to a guest.
    expect(author.revision).toBe(revision);
    expect(profileReads()).toBe(reads);
    await act(async () => release());
    expect(author.revision).toBe(revision + 1);
    expect(profileReads()).toBe(reads + 1);
    expect(checks()).toBe(1);
  });

  it("pauses a pending avatar save while held and resumes it on release", async () => {
    let answer: (value: Response) => void = () => {};
    avatar = () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      });
    const key = `yoyi-avatar-save-v1:${owner.id}`;
    window.localStorage.setItem(
      key,
      JSON.stringify({
        accountId: owner.id,
        uploadId: "00000000-0000-4000-8000-000000000001",
        saveId: "00000000-0000-4000-8000-000000000002",
        png: "data:image/png;base64,iVBORw0KGgo=",
        mediaId: `user-media-${"c".repeat(32)}`,
      }),
    );
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });
    expect(avatarSaves()).toBe(1);
    const revision = author.revision;
    const reads = profileReads();
    const release = author.holdSession();
    // The save under way stops before its next request (the profile read
    // that would end in onSaved and a revision change).
    await act(async () =>
      answer(reply({ nextChangeAt: "2026-10-27T01:00:00.000Z" })),
    );
    expect(profileReads()).toBe(reads);
    expect(author.revision).toBe(revision);
    expect(window.localStorage.getItem(key)).not.toBeNull();
    // Nothing new starts while held.
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });
    expect(avatarSaves()).toBe(1);
    avatar = async () => reply({ nextChangeAt: "2026-10-27T01:00:00.000Z" });
    await act(async () => release());
    await vi.waitFor(() => expect(avatarSaves()).toBe(2));
  });
});
