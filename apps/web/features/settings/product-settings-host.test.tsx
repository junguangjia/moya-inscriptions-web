// @vitest-environment jsdom
import { act, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { AuthorProfile } from "@moya/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SettingsProps = {
  profile: AuthorProfile | null;
  onClose: () => void;
  onSaved: () => void;
  onEdit?: (() => void) | undefined;
  accountRead: { loading: boolean; error: string; onRetry: () => void };
};
type EditorProps = {
  profile: AuthorProfile;
  onClose: () => void;
  onSaved: () => void;
};
const { author, profileRead, shell, intent, captures, AuthorRequestError } =
  vi.hoisted(() => ({
    AuthorRequestError: class AuthorRequestError extends Error {
      constructor(
        readonly status: number,
        message: string,
      ) {
        super(message);
      }
    },
    author: {
      viewer: null as { id: string } | null,
      checking: false,
      sessionError: false,
      revision: 0,
      cache: new Map<string, unknown>(),
      refresh: vi.fn(),
      mutate: vi.fn(),
    },
    profileRead: vi.fn(),
    shell: {
      activeDestination: "home",
      settingsOpen: false,
      registerSettingsIntent: vi.fn(),
    },
    intent: { current: null as ((opener: HTMLElement) => void) | null },
    captures: { settings: [] as SettingsProps[], editors: [] as EditorProps[] },
  }));
vi.mock("../authors/author-context", () => ({ useAuthors: () => author }));
vi.mock("../authors/author-data", () => ({
  authorClient: { profile: profileRead },
  AuthorRequestError,
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => shell,
}));
vi.mock("../authors/profile-settings", () => ({
  ProfileSettings: (props: SettingsProps) => {
    captures.settings.push(props);
    return (
      <section
        role="dialog"
        data-settings-host-stub=""
        data-profile={props.profile?.id ?? ""}
      >
        <button onClick={props.onClose}>关闭设置</button>
        <button onClick={props.onSaved}>设置已保存</button>
        {props.onEdit && <button onClick={props.onEdit}>编辑信息</button>}
        <button onClick={props.accountRead.onRetry}>重试账户读取</button>
      </section>
    );
  },
}));
vi.mock("../authors/profile-editor", () => ({
  ProfileEditor: (props: EditorProps) => {
    captures.editors.push(props);
    return (
      <section
        role="dialog"
        data-profile-editor-stub=""
        data-profile={props.profile.id}
      >
        <button onClick={props.onSaved}>编辑已保存</button>
        <button onClick={props.onClose}>返回设置</button>
      </section>
    );
  },
}));
import { ProductSettingsHost } from "./product-settings-host";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const actorA = "user-" + "a".repeat(32),
  actorB = "user-" + "b".repeat(32);
const profile = (id = actorA, displayName = "合成账户"): AuthorProfile => ({
  id,
  handle: "synthetic-settings-host",
  displayName,
  bio: "",
  avatar: null,
  isOwner: true,
  following: false,
  privacy: {
    following: "private",
    followers: "private",
    favorites: "private",
    likes: "private",
  },
  totals: { works: 0, following: 0, followers: 0, favorites: 0, likes: 0 },
  nextAvatarChangeAt: null,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const roots: Root[] = [];
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
beforeEach(() => {
  author.viewer = null;
  author.checking = false;
  author.sessionError = false;
  author.revision = 0;
  author.cache.clear();
  author.refresh.mockReset().mockResolvedValue(undefined);
  author.mutate.mockReset();
  profileRead.mockReset();
  shell.settingsOpen = false;
  shell.activeDestination = "home";
  captures.settings.length = 0;
  captures.editors.length = 0;
  intent.current = null;
  frames.clear();
  frameId = 0;
  shell.registerSettingsIntent
    .mockReset()
    .mockImplementation((next: (opener: HTMLElement) => void) => {
      intent.current = next;
      return () => {
        if (intent.current === next) intent.current = null;
      };
    });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 44,
      bottom: 44,
      width: 44,
      height: 44,
      toJSON: () => ({}),
    }),
  );
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
const render = async (initialOpen = false, deferClose = false) => {
  const target = document.createElement("div");
  document.body.append(target);
  const root = createRoot(target);
  roots.push(root);
  const opened = vi.fn(),
    closed = vi.fn();
  const control: {
    open?: (opener?: HTMLElement) => void;
    commitClose?: () => void;
  } = {};
  const Harness = () => {
    const [open, setOpen] = useState(initialOpen);
    const [initialOpener, setInitialOpener] = useState<HTMLElement | null>(
      null,
    );
    const onOpen = useCallback((opener?: HTMLElement) => {
      opened();
      setInitialOpener(opener ?? null);
      setOpen(true);
    }, []);
    control.open = onOpen;
    const onClose = useCallback(() => {
      closed();
      if (deferClose) control.commitClose = () => setOpen(false);
      else setOpen(false);
    }, []);
    return (
      <>
        <section hidden inert data-inactive-user-page="">
          <button>隐藏的用户页设置</button>
        </section>
        <button aria-label="设置">全局设置</button>
        <ProductSettingsHost
          open={open}
          onOpen={onOpen}
          onClose={onClose}
          initialOpener={initialOpener}
        />
      </>
    );
  };
  const draw = async () => {
    await act(async () => root.render(<Harness />));
  };
  await draw();
  const gear = target.querySelector<HTMLButtonElement>(
    'button[aria-label="设置"]',
  )!;
  return {
    target,
    gear,
    opened,
    closed,
    commitClose: async () => {
      await act(async () => control.commitClose?.());
    },
    draw,
    open: async (focus = true) => {
      if (focus) gear.focus();
      await act(async () => intent.current!(gear));
    },
    directOpen: async (opener: HTMLElement) => {
      await act(async () => control.open!(opener));
    },
    props: () => captures.settings.at(-1)!,
    editor: () => captures.editors.at(-1)!,
    flush: async () => {
      await act(async () => {
        const tasks = [...frames.values()];
        frames.clear();
        tasks.forEach((task) => task(performance.now()));
      });
    },
    unmount: async () => {
      roots.splice(roots.indexOf(root), 1);
      await act(async () => root.unmount());
    },
  };
};

describe("complete product settings host", () => {
  it("registers while the User page is hidden and opens the complete host outside that page from every primary destination", async () => {
    const view = await render();
    expect(intent.current).toBeTypeOf("function");
    expect(profileRead).not.toHaveBeenCalled();
    for (const destination of ["home", "discussion", "user"]) {
      shell.activeDestination = destination;
      await view.draw();
      await view.open();
      const modal = view.target.querySelector("[data-settings-host-stub]")!;
      expect(modal.closest('[hidden],[inert],[aria-hidden="true"]')).toBeNull();
      expect(view.props().profile).toBeNull();
      expect(view.props().accountRead).toMatchObject({
        loading: false,
        error: "",
      });
      await act(async () => view.props().onClose());
      await view.flush();
    }
    expect(view.opened).toHaveBeenCalledTimes(3);
    await view.unmount();
    expect(intent.current).toBeNull();
  });
  it("uses only the current actor's owned cached profile immediately and revalidates that same actor", async () => {
    author.viewer = { id: actorA };
    const cached = profile();
    author.cache.set(`profile:${actorA}`, cached);
    const pending = deferred<AuthorProfile>();
    profileRead.mockReturnValue(pending.promise);
    const view = await render();
    await view.open();
    expect(view.props().profile).toBe(cached);
    expect(view.props().accountRead.loading).toBe(false);
    expect(profileRead).toHaveBeenCalledExactlyOnceWith(actorA);
    const next = profile(actorA, "更新后的合成账户");
    await act(async () => pending.resolve(next));
    expect(view.props().profile).toBe(next);
    expect(author.cache.get(`profile:${actorA}`)).toBe(next);
  });
  it("cold-loads the exact current profile and offers edit only after a confirmed owned result", async () => {
    author.viewer = { id: actorA };
    const pending = deferred<AuthorProfile>();
    profileRead.mockReturnValue(pending.promise);
    const view = await render();
    await view.open();
    expect(view.props().profile).toBeNull();
    expect(view.props().onEdit).toBeUndefined();
    expect(view.props().accountRead).toMatchObject({
      loading: true,
      error: "",
    });
    const next = profile();
    await act(async () => pending.resolve(next));
    expect(view.props().profile).toBe(next);
    expect(view.props().onEdit).toBeTypeOf("function");
  });
  it("retains a truthful cold-read error and retries without borrowing another cached account", async () => {
    author.viewer = { id: actorA };
    author.cache.set(`profile:${actorB}`, profile(actorB));
    const first = deferred<AuthorProfile>(),
      second = deferred<AuthorProfile>();
    profileRead
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = await render();
    await view.open();
    await act(async () =>
      first.reject(new AuthorRequestError(503, "账户资料读取失败")),
    );
    expect(view.props().profile).toBeNull();
    expect(view.props().accountRead).toMatchObject({
      loading: false,
      error: "账户资料读取失败",
    });
    await act(async () => view.props().accountRead.onRetry());
    expect(profileRead.mock.calls.map((call) => call[0])).toEqual([
      actorA,
      actorA,
    ]);
    expect(view.props().accountRead).toMatchObject({
      loading: true,
      error: "",
    });
    const next = profile();
    await act(async () => second.resolve(next));
    expect(view.props().profile).toBe(next);
  });
  it("ignores a late actor A response after actor B becomes current", async () => {
    author.viewer = { id: actorA };
    const first = deferred<AuthorProfile>(),
      second = deferred<AuthorProfile>();
    profileRead
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = await render();
    await view.open();
    author.viewer = { id: actorB };
    await view.draw();
    expect(view.props().profile).toBeNull();
    await act(async () => first.resolve(profile(actorA)));
    expect(view.props().profile).toBeNull();
    expect(author.cache.has(`profile:${actorA}`)).toBe(false);
    const next = profile(actorB);
    await act(async () => second.resolve(next));
    expect(view.props().profile).toBe(next);
    expect(author.cache.get(`profile:${actorB}`)).toBe(next);
  });
  it("rejects a mismatched or non-owner profile answer instead of enabling another account's settings", async () => {
    author.viewer = { id: actorA };
    profileRead.mockResolvedValue(profile(actorB));
    const view = await render();
    await view.open();
    expect(view.props().profile).toBeNull();
    expect(view.props().onEdit).toBeUndefined();
    expect(view.props().accountRead.error).not.toBe("");
    expect(author.cache.has(`profile:${actorA}`)).toBe(false);
    profileRead.mockResolvedValue({ ...profile(actorA), isOwner: false });
    await act(async () => view.props().accountRead.onRetry());
    expect(view.props().profile).toBeNull();
    expect(view.props().onEdit).toBeUndefined();
  });
  it("reports identity checking and session failures honestly without issuing a private read until identity is confirmed", async () => {
    author.checking = true;
    const view = await render();
    await view.open();
    expect(view.props().accountRead).toMatchObject({
      loading: true,
      error: "",
    });
    expect(profileRead).not.toHaveBeenCalled();
    author.checking = false;
    author.sessionError = true;
    await view.draw();
    expect(view.props().accountRead.loading).toBe(false);
    expect(view.props().accountRead.error).not.toBe("");
    expect(view.props().profile).toBeNull();
    await act(async () => view.props().accountRead.onRetry());
    expect(author.refresh).toHaveBeenCalledOnce();
    expect(profileRead).not.toHaveBeenCalled();
    author.sessionError = false;
    author.viewer = { id: actorA };
    const next = profile();
    profileRead.mockResolvedValue(next);
    await view.draw();
    expect(view.props().profile).toBe(next);
  });
  it("keeps a known same-actor cache while checking but labels the account read as pending", async () => {
    author.viewer = { id: actorA };
    author.checking = true;
    const cached = profile();
    author.cache.set(`profile:${actorA}`, cached);
    const view = await render();
    await view.open();
    expect(view.props().profile).toBe(cached);
    expect(view.props().accountRead.loading).toBe(true);
    expect(profileRead).not.toHaveBeenCalled();
  });
  it("round-trips through the existing editor, refreshes its own profile and returns focus to the original global opener", async () => {
    author.viewer = { id: actorA };
    const cached = profile();
    author.cache.set(`profile:${actorA}`, cached);
    profileRead.mockResolvedValue(cached);
    const view = await render();
    await view.open();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await act(async () => view.props().onEdit!());
    expect(
      view.target.querySelector("[data-profile-editor-stub]"),
    ).not.toBeNull();
    expect(view.editor().profile).toBe(cached);
    view.target
      .querySelector<HTMLButtonElement>("[data-profile-editor-stub] button")!
      .focus();
    focus.mockClear();
    const updated = profile(actorA, "编辑后的合成账户");
    profileRead.mockResolvedValue(updated);
    await act(async () => view.editor().onSaved());
    expect(author.mutate).toHaveBeenCalledOnce();
    expect(profileRead).toHaveBeenCalledTimes(2);
    expect(author.cache.get(`profile:${actorA}`)).toBe(updated);
    await act(async () => view.editor().onClose());
    expect(view.target.querySelector("[data-profile-editor-stub]")).toBeNull();
    expect(view.props().profile).toBe(updated);
    expect(view.closed).not.toHaveBeenCalled();
    await act(async () => view.props().onClose());
    await view.flush();
    expect(view.closed).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(view.gear);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });
  it("waits for the close commit before restoring focus outside native modality", async () => {
    const view = await render(false, true);
    await view.open();
    const nativeFocus = HTMLElement.prototype.focus;
    const focus = vi.spyOn(view.gear, "focus").mockImplementation((options) => {
      // A native modal ignores focus attempts outside it until removal.
      if (!view.target.querySelector("[data-settings-host-stub]"))
        nativeFocus.call(view.gear, options);
    });
    await act(async () => view.props().onClose());
    await view.flush();
    expect(view.closed).toHaveBeenCalledOnce();
    expect(
      view.target.querySelector("[data-settings-host-stub]"),
    ).not.toBeNull();
    expect(focus).not.toHaveBeenCalled();
    await view.commitClose();
    await view.flush();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(document.activeElement).toBe(view.gear);
  });

  it("refreshes the current actor after a settings save and never edits a guest", async () => {
    const view = await render();
    await view.open();
    expect(view.props().onEdit).toBeUndefined();
    author.viewer = { id: actorA };
    const cached = profile();
    profileRead.mockResolvedValue(cached);
    await view.draw();
    const changed = profile(actorA, "保存后的合成账户");
    profileRead.mockResolvedValue(changed);
    await act(async () => view.props().onSaved());
    expect(author.mutate).toHaveBeenCalledOnce();
    expect(profileRead.mock.calls.map((call) => call[0])).toEqual([
      actorA,
      actorA,
    ]);
    expect(view.props().profile).toBe(changed);
  });
  it("does not commit a pending private read after the host closes", async () => {
    author.viewer = { id: actorA };
    const pending = deferred<AuthorProfile>();
    profileRead.mockReturnValue(pending.promise);
    const view = await render();
    await view.open();
    await act(async () => view.props().onClose());
    await act(async () => pending.resolve(profile()));
    expect(author.cache.has(`profile:${actorA}`)).toBe(false);
    expect(view.target.querySelector("[data-settings-host-stub]")).toBeNull();
  });
  it("cancels a queued opener-focus restoration when the utility host unmounts", async () => {
    const view = await render();
    await view.open();
    await act(async () => view.props().onClose());
    expect(frames.size).toBe(1);
    await view.unmount();
    expect(frames.size).toBe(0);
  });
  it("uses the caller-provided opener for a profile-entry open that bypasses the global intent", async () => {
    const view = await render();
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    await view.directOpen(view.gear);
    await act(async () => view.props().onClose());
    await view.flush();
    expect(document.activeElement).toBe(view.gear);
  });
  it("uses the visible global settings control when a restored open host has no real opener", async () => {
    const view = await render(true);
    expect(document.activeElement).toBe(document.body);
    await act(async () => view.props().onClose());
    await view.flush();
    expect(document.activeElement).toBe(view.gear);
  });
  it("returns focus to the explicit registered opener even when the browser did not focus that button on activation", async () => {
    const view = await render();
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    await view.open(false);
    await act(async () => view.props().onClose());
    await view.flush();
    expect(document.activeElement).toBe(view.gear);
  });
});

describe("non-transport settings read failures", () => {
  it.each([
    new SyntaxError("Unexpected token in synthetic profile JSON"),
    Object.assign(
      new Error(
        '[{"code":"invalid_type","path":["profile"],"message":"expected object"}]',
      ),
      { name: "ZodError" },
    ),
  ])(
    "uses safe product copy for a %s instead of rendering parser/schema details",
    async (failure) => {
      author.viewer = { id: actorA };
      profileRead.mockRejectedValue(failure);
      const view = await render();
      await view.open();
      expect(view.props().profile).toBeNull();
      expect(view.props().accountRead).toMatchObject({
        loading: false,
        error: "账户资料暂时无法读取，请重试。",
      });
      expect(view.props().accountRead.error).not.toContain(failure.message);
      expect(view.props().onEdit).toBeUndefined();
    },
  );
});
