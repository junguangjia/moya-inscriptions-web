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
  figures: {
    irreversibleTargets: 3,
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
  const page = (overrides: Partial<AdminMcpControlPage> = {}) =>
    renderToStaticMarkup(
      createElement(McpControlClient, { page: { ...PAGE, ...overrides } }),
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
    expect(html).toContain('href="/admin/collections/mcp-audit-events"');
    expect(html).toContain('href="/admin/collections/payload-mcp-api-keys"');
  });

  it("says when the audit figures are unavailable, rather than showing zero", () => {
    const html = page({ figures: null });
    expect(html).toContain("操作记录暂时无法读取");
    expect(html).not.toContain("24 小时内不可逆操作对象数");
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
    mount(createElement(McpControlClient, { page: PAGE }));
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
});
