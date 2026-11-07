// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  cleanup,
  fireEvent,
  render as mount,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminViewServerProps } from "payload";
import type { ReactNode } from "react";
import type { AdminMcpControlPage } from "@moya/contracts/internal/admin-mcp";

const runtime = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const { join } = await import("node:path");
  const adminRequire = createRequire(
    join(import.meta.dirname, "../../../apps/admin/"),
  );
  return {
    ui: realpathSync(adminRequire.resolve("@payloadcms/ui")),
    templates: realpathSync(adminRequire.resolve("@payloadcms/next/templates")),
    navigation: realpathSync(adminRequire.resolve("next/navigation")),
    readControlPage: vi.fn(),
    refresh: vi.fn(),
  };
});
vi.mock(runtime.ui, () => ({ SetStepNav: () => null }));
vi.mock(runtime.templates, () => ({
  DefaultTemplate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock(runtime.navigation, () => ({
  useRouter: () => ({ refresh: runtime.refresh }),
}));
vi.mock("../../../apps/admin/src/admin-mcp/control/page-data", () => ({
  readControlPage: runtime.readControlPage,
}));

import { McpControlView } from "admin/admin-mcp-control-view";
import { McpControlClient } from "admin/admin-mcp-control-client";

// Behavior Matrix "Admin control page and audit list": Payload skips the login
// redirect for custom views, so the view gates itself and reads nothing until it
// has. The real request path is covered by tests/cms/admin-mcp-control.test.ts.

const COOKIE = "payload-token=synthetic";

const props = (
  user: Record<string, unknown> | null,
  headers: Record<string, string> = {},
): AdminViewServerProps =>
  ({
    initPageResult: {
      req: {
        user,
        headers: new Headers(headers),
        payload: { config: { cookiePrefix: "payload" } },
      },
      visibleEntities: {},
    },
  }) as unknown as AdminViewServerProps;

const owner = { collection: "users", role: "owner", _strategy: "local-jwt" };

const AWAITING = "8c3f1e2a-1234-4abc-8def-0123456789ab";
const STALLED = "9d4f2e3b-2345-4bcd-9ef0-123456789abc";
const SEAL = "a".repeat(64);

const PAGE: AdminMcpControlPage = {
  pause: false,
  threshold: 20,
  switches: [
    {
      category: "dm",
      label: "私信",
      open: false,
      openedAt: null,
      policyCovers: false,
      phrase: "确认文字",
    },
    {
      category: "rawIp",
      label: "原始 IP 记录",
      open: true,
      openedAt: "2026-11-03T00:00:00.000Z",
      policyCovers: true,
      phrase: "另一句",
    },
  ],
  expiringKeys: [
    {
      id: 7,
      label: "synthetic key",
      expiresAt: "2026-11-04T00:00:00.000Z",
      lastUsedAt: null,
    },
  ],
  runs: {
    awaiting: [
      {
        runId: AWAITING,
        op: "editorial.save-draft",
        credential: "key:7",
        credentialLabel: "synthetic key",
        reason: "<b>合成</b> reason",
        count: 25,
        conflicts: 1,
        impact: { affectedReplies: 4 },
        sample: [
          { index: 0, ref: 11 },
          { index: 1, ref: null },
        ],
        consequences: ["identity_bound_permanently", "subject_notified"],
        userNotifications: 3,
        newIdentities: {
          count: 25,
          first: [{ index: 0, field: "catalogId", value: "synthetic-1" }],
        },
        expiresAt: "2026-11-07T00:00:00.000Z",
        sealHash: SEAL,
      },
    ],
    stalled: [
      {
        runId: STALLED,
        op: "community.moderate-comment",
        credential: "conn:synthetic",
        credentialLabel: null,
        state: "running",
        count: 3,
        done: 1,
        updatedAt: "2026-11-06T00:00:00.000Z",
      },
    ],
  },
  figures: {
    irreversibleTargets: 3,
    irreversibleByCredential: [{ credential: "key:7", targets: 3 }],
    outcomeUnknown: 2,
    timings: [
      { tool: "admin_whoami", calls: 200, p95Ms: 40, budgetMs: 100 },
      { tool: "editorial_query", calls: 5, p95Ms: 90, budgetMs: null },
    ],
  },
};

const render = async (viewProps: AdminViewServerProps) =>
  renderToStaticMarkup(await McpControlView(viewProps));

beforeEach(() => {
  runtime.readControlPage.mockReset();
  runtime.readControlPage.mockResolvedValue(PAGE);
});

describe("the control view gate", () => {
  it.each([
    ["an anonymous request", null, { cookie: COOKIE }],
    [
      "an MCP key on the owner row",
      { collection: "users", role: "owner", _strategy: "mcp-api-key" },
      { cookie: COOKIE },
    ],
    [
      "an ai_operator key",
      { collection: "users", role: "ai_operator", _strategy: "mcp-api-key" },
      { cookie: COOKIE },
    ],
    [
      "an automation account",
      { collection: "users", role: "automation", _strategy: "local-jwt" },
      { cookie: COOKIE },
    ],
    [
      "an Owner REST key",
      { collection: "users", role: "owner", _strategy: "api-key" },
      { cookie: COOKIE },
    ],
    [
      "an Owner JWT sent in a header",
      owner,
      { authorization: "JWT synthetic", cookie: COOKIE },
    ],
    ["an Owner JWT with no cookie", owner, {}],
  ])("refuses %s and reads nothing", async (_label, user, headers) => {
    const html = await render(props(user, headers));
    expect(html).toContain('role="alert"');
    expect(html).toContain("此工作区仅限 Owner。");
    expect(html).not.toContain("data-mcp-control");
    expect(runtime.readControlPage).not.toHaveBeenCalled();
  });

  it("opens only for the Owner browser session", async () => {
    const html = await render(props(owner, { cookie: COOKIE }));
    expect(html).toContain("data-mcp-control");
    expect(runtime.readControlPage).toHaveBeenCalledOnce();
  });
});

describe("the control page", () => {
  const page = (
    overrides: Partial<AdminMcpControlPage> = {},
    connections = true,
  ) =>
    renderToStaticMarkup(
      createElement(McpControlClient, {
        connections,
        page: { ...PAGE, ...overrides },
      }),
    );

  it("shows pause, threshold and policy-text status for each switch", () => {
    const html = page();
    expect(html).toContain('data-mcp-pause="false"');
    expect(html).toContain("立即暂停");
    expect(html).toContain('value="20"');
    expect(html).toContain('data-mcp-switch="dm"');
    expect(html).toContain('data-mcp-policy="uncovered"');
    expect(html).toContain('data-mcp-switch="rawIp"');
    expect(html).toContain('data-mcp-policy="covered"');
  });

  it("links to the AI connections page, and labels its key list for automation", () => {
    const html = page();
    expect(html).toContain('href="/admin/agent-connections"');
    expect(html).toContain("即将到期的自动化密钥");
    expect(html).toContain("暂停后所有 AI 连接和密钥只能调用 admin_whoami");
  });

  it("reads as it did before the login door while the door is off", () => {
    for (const pause of [false, true]) {
      const html = page({ pause }, false);
      expect(html).not.toContain('href="/admin/agent-connections"');
      expect(html).not.toContain("AI 连接");
      expect(html).toContain(
        pause
          ? "已暂停。所有密钥只能调用 admin_whoami，下一次请求起生效。"
          : "运行中。暂停后所有密钥只能调用 admin_whoami，后台页面不受影响。",
      );
      expect(html).toContain("即将到期的密钥");
      // The links that were there before stay.
      expect(html).toContain('href="/admin/collections/mcp-audit-events"');
    }
  });

  it("takes the door's state from the server view", async () => {
    try {
      vi.stubEnv("NODE_ENV", "production");
      expect(await render(props(owner, { cookie: COOKIE }))).not.toContain(
        'href="/admin/agent-connections"',
      );
      vi.stubEnv("ADMIN_MCP_OAUTH_ENABLED", "true");
      expect(await render(props(owner, { cookie: COOKIE }))).toContain(
        'href="/admin/agent-connections"',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("offers a resume while paused", () => {
    const html = page({ pause: true });
    expect(html).toContain('data-mcp-pause="true"');
    expect(html).toContain("恢复");
    expect(html).not.toContain("立即暂停");
  });

  it("shows expiring keys, audit figures and timings against their budget", () => {
    const html = page();
    expect(html).toContain('data-mcp-key="7"');
    expect(html).toContain("续期 30 天");
    expect(html).toContain('data-mcp-timing="admin_whoami"');
    expect(html).toContain("<td>100</td>");
    // The 24-hour irreversible figure, and the same by credential.
    expect(html).toContain("24 小时内不可逆操作对象数");
    expect(html).toContain("其中 key:7");
    expect(html).toContain('href="/admin/collections/mcp-audit-events"');
    expect(html).toContain('href="/admin/collections/payload-mcp-api-keys"');
  });

  it("says when the audit figures are unavailable, rather than showing zero", () => {
    const html = page({ figures: null });
    expect(html).toContain("操作记录暂时无法读取");
    expect(html).not.toContain("24 小时内不可逆操作对象数");
  });

  // S8-11: a run past the threshold, as its preview froze it, and one left stalled.
  it("lists a run waiting for the Owner by what its preview froze, the caller's words as text", () => {
    const html = page();
    expect(html).toContain(`data-mcp-run="${AWAITING}"`);
    expect(html).toContain("editorial.save-draft");
    expect(html).toContain("25 个对象");
    expect(html).toContain("另有 1 个预览时已冲突，不会执行");
    expect(html).toContain("synthetic key（key:7）");
    expect(html).toContain('data-mcp-consequence="identity_bound_permanently"');
    expect(html).toContain("每个新身份会永久绑定到它的记录");
    expect(html).toContain("每位当事人都会收到一条关于此操作的消息");
    expect(html).toContain("3 位当事人会收到消息");
    expect(html).toContain("永久绑定 25 个新身份，例如：catalogId synthetic-1");
    expect(html).toContain("#0 11、#1");
    // What the caller wrote is text: escaped, never markup.
    expect(html).toContain("&lt;b&gt;合成&lt;/b&gt; reason");
    expect(html).not.toContain("<b>合成</b>");
    expect(html).toContain(`data-mcp-run-confirm="${AWAITING}"`);
    expect(html).toContain(`data-mcp-stalled-run="${STALLED}"`);
    expect(html).toContain("已完成 1 / 3");
    expect(html).toContain("来自 conn:synthetic");
  });

  it("says when nothing waits, and when the runs cannot be read, rather than showing none", () => {
    const empty = page({ runs: { awaiting: [], stalled: [] } });
    expect(empty).toContain("没有等待确认的操作。");
    expect(empty).not.toContain("data-mcp-stalled-runs");
    const unread = page({ runs: null });
    expect(unread).toContain("操作列表暂时无法读取。");
    expect(unread).not.toContain("没有等待确认的操作");
  });
});

describe("the control page's writes", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const lastCall = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
    return {
      url,
      method: init?.method,
      credentials: init?.credentials,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : undefined,
    };
  };

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(Response.json({ result: {} }));
    runtime.refresh.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    mount(createElement(McpControlClient, { connections: true, page: PAGE }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("pauses with one click, same-origin, and re-reads from the server", async () => {
    fireEvent.click(screen.getByRole("button", { name: "立即暂停" }));
    await waitFor(() => expect(runtime.refresh).toHaveBeenCalledOnce());
    expect(lastCall()).toEqual({
      url: "/api/globals/mcp-control?depth=0",
      method: "POST",
      credentials: "same-origin",
      body: { pause: true },
    });
    expect(screen.getByRole("status").textContent).toContain("已暂停");
  });

  it("opens a switch only after its phrase is typed, and sends the phrase", async () => {
    const row = screen
      .getByText("私信", { selector: "strong" })
      .closest("li") as HTMLElement;
    fireEvent.click(row.querySelector("button") as HTMLButtonElement);
    const input = row.querySelector("input") as HTMLInputElement;
    const confirm = screen.getByRole("button", { name: "确认开启" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "差一个字" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "确认文字" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(runtime.refresh).toHaveBeenCalledOnce());
    expect(lastCall().body).toEqual({
      dm: true,
      complianceConfirmation: "确认文字",
    });
  });

  it("closes an open switch with no phrase", async () => {
    const row = screen
      .getByText("原始 IP 记录", { selector: "strong" })
      .closest("li") as HTMLElement;
    fireEvent.click(row.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(runtime.refresh).toHaveBeenCalledOnce());
    expect(lastCall().body).toEqual({ rawIp: false });
  });

  it("names the server's refusal and does not re-read", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          errors: [
            {
              message: "x",
              data: { code: "COMPLIANCE_CONFIRMATION_REQUIRED" },
            },
          ],
        },
        { status: 400 },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "立即暂停" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("确认文字不一致"),
    );
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it("names it from the message alone, as a production build answers once a page has loaded", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { errors: [{ message: "COMPLIANCE_ONE_SWITCH_AT_A_TIME" }] },
        { status: 400 },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "立即暂停" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("一次只能开启"),
    );
  });

  it("says a dropped connection may not have taken effect", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "立即暂停" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("可能没有生效"),
    );
  });

  it("saves only a positive whole threshold", async () => {
    const input = screen.getByLabelText("对象数");
    const save = screen.getByRole("button", { name: "保存" });
    for (const value of ["0", "-3", "1.5"]) {
      fireEvent.change(input, { target: { value } });
      expect((save as HTMLButtonElement).disabled, value).toBe(true);
    }
    fireEvent.change(input, { target: { value: "25" } });
    fireEvent.click(save);
    await waitFor(() => expect(runtime.refresh).toHaveBeenCalledOnce());
    expect(lastCall().body).toEqual({ threshold: 25 });
  });

  it("renews a key by its own route", async () => {
    fireEvent.click(screen.getByRole("button", { name: "续期 30 天" }));
    await waitFor(() => expect(runtime.refresh).toHaveBeenCalledOnce());
    expect(lastCall()).toMatchObject({
      url: "/api/mcp-control/keys/7/renew",
      method: "POST",
      credentials: "same-origin",
    });
  });

  const runRow = (attribute: string, id: string) =>
    document.querySelector(`[${attribute}="${id}"]`) as HTMLElement;

  it("confirms a run by its own route, bound to the seal the page showed", async () => {
    fireEvent.click(
      runRow("data-mcp-run", AWAITING).querySelector(
        "[data-mcp-run-confirm]",
      ) as HTMLButtonElement,
    );
    await waitFor(() => expect(runtime.refresh).toHaveBeenCalledOnce());
    expect(lastCall()).toEqual({
      url: `/api/mcp-control/runs/${AWAITING}/confirm`,
      method: "POST",
      credentials: "same-origin",
      body: { expectedSealHash: SEAL },
    });
    expect(screen.getByRole("status").textContent).toContain("已确认");
  });

  it("cancels a waiting run and a stalled one by its own route", async () => {
    for (const [attribute, id] of [
      ["data-mcp-run", AWAITING],
      ["data-mcp-stalled-run", STALLED],
    ] as const) {
      runtime.refresh.mockReset();
      fireEvent.click(
        runRow(attribute, id).querySelector(
          "[data-mcp-run-cancel]",
        ) as HTMLButtonElement,
      );
      await waitFor(() => expect(runtime.refresh).toHaveBeenCalledOnce());
      expect(lastCall()).toMatchObject({
        url: `/api/mcp-control/runs/${id}/cancel`,
        method: "POST",
        credentials: "same-origin",
      });
    }
  });

  it("names a run's refusal and does not re-read", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "SEAL_HASH_MISMATCH" }, { status: 409 }),
    );
    fireEvent.click(
      runRow("data-mcp-run", AWAITING).querySelector(
        "[data-mcp-run-confirm]",
      ) as HTMLButtonElement,
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "和页面显示的不一致",
      ),
    );
    expect(runtime.refresh).not.toHaveBeenCalled();
  });
});
