// @vitest-environment jsdom
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminViewServerProps } from "payload";
import type { ReactNode } from "react";

// The page sets the Admin breadcrumb through Payload's `SetStepNav`, and that
// package's client barrel imports CSS, which this jsdom run cannot load. The
// same problem and the same shape of answer already exist in
// `community-bulk-actions.test.ts`: name the file the component actually
// resolves, because the package is reachable only from the Admin workspace.
const payload = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const { join } = await import("node:path");
  // Under jsdom import.meta.url is an http URL; the directory stays a path.
  const adminRequire = createRequire(
    join(import.meta.dirname, "../../../apps/admin/"),
  );
  return {
    ui: realpathSync(adminRequire.resolve("@payloadcms/ui")),
    templates: realpathSync(adminRequire.resolve("@payloadcms/next/templates")),
    navigation: realpathSync(adminRequire.resolve("next/navigation")),
    setStepNav: vi.fn(),
    getPreference: vi.fn(),
    setPreference: vi.fn(),
    consentRuntime: vi.fn(),
  };
});
vi.mock(payload.ui, () => ({
  // Records the breadcrumb instead of rendering it, so the page's claim about
  // its own location is assertable here rather than only in a browser.
  SetStepNav: ({ nav }: { readonly nav: readonly { label: string }[] }) => {
    payload.setStepNav(nav);
    return null;
  },
  useNav: () => ({ navOpen: true }),
  usePreferences: () => ({
    getPreference: payload.getPreference,
    setPreference: payload.setPreference,
  }),
}));
vi.mock(payload.templates, () => ({
  DefaultTemplate: ({ children }: { children: ReactNode }) => children,
}));
// `redirect` and `notFound` work by throwing, so these do too: a view that caught
// one would show its refusal instead, and the test would see that.
vi.mock(payload.navigation, () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT ${path}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("../../../apps/admin/src/agent-connections/runtime", () => ({
  consentRuntime: payload.consentRuntime,
}));

import { AgentConnectionsClient } from "admin/agent-connections-client";
import ConsentLandingPage from "../../../apps/admin/app/(agent-connections)/agent-connections/consent/[uid]/page";
import { AgentConsentClient } from "admin/agent-connections-consent-client";
import { NewConnectionNotice } from "admin/agent-connections-notice";
import { OperatorConnectionsClient } from "admin/agent-connections-operator-client";
import {
  AgentConnectionsView,
  AgentConsentView,
} from "admin/agent-connections-view";

/**
 * The `AI 连接` page, at the points where the redesign added logic of its own
 * rather than markup.
 *
 * Everything else about this page is rendering, and rendering is what the
 * screenshots are for. What is worth a test is the behaviour a reader cannot
 * check by looking: that a destructive action does not fire on the first
 * click, that every registered client is reachable and starts the one it
 * names, and that "authorized" is not printed for a connection with nothing
 * behind it.
 *
 * Three of these tests exist because an independent review found the earlier
 * page deciding, from a registration's `family`, which clients were "real".
 * The integration guide tells integrators that `family` is any value, and the
 * acceptance harness registers a test identity under `family: "cursor"`, so
 * that rule was wrong in both directions. These pin the replacement: the
 * family selects setup copy, and nothing else.
 */

const connection = (overrides: Record<string, unknown> = {}) => ({
  id: "conn-0123456789abcdef0123456789abcdef",
  client: "cursor",
  clientLabel: "Cursor Desktop",
  principalLabel: "agent-cursor-0123456789ab",
  oauthClientId: "artvenn-cursor-readonly",
  environment: "synthetic",
  preset: "read-only",
  status: "authorized",
  generation: 1,
  consentedAt: "2026-09-21T00:00:00.000Z",
  revokedAt: null,
  lastVerifiedAt: "2026-09-21T00:01:00.000Z",
  hasCurrentGrant: true,
  ...overrides,
});

const result = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  result: {
    connections: [connection()],
    clients: [
      {
        clientId: "artvenn-cursor-readonly",
        family: "cursor",
        label: "Cursor Desktop",
      },
      {
        clientId: "artvenn-local-verify",
        family: "verification",
        label: "Local verification client",
      },
    ],
    environment: "synthetic",
    issuer: "http://127.0.0.1:3451",
    resource: "http://localhost:3452/api/mcp",
    authMethod: "oauth-browser-consent",
    ...overrides,
  },
});

let posted: { url: string; body: unknown }[] = [];

const mockFetch = (body: unknown) =>
  vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST")
      posted.push({ url: String(url), body: JSON.parse(init.body ?? "{}") });
    return {
      ok: true,
      json: async () => (init?.method === "POST" ? { ok: true } : body),
    } as unknown as Response;
  });

beforeEach(() => {
  posted = [];
  payload.setStepNav.mockClear();
  // jsdom implements neither modal dialogs nor the clipboard.
  if (!HTMLDialogElement.prototype.showModal)
    HTMLDialogElement.prototype.showModal = function showModal(
      this: HTMLDialogElement,
    ) {
      this.open = true;
    };
  if (!HTMLDialogElement.prototype.close)
    HTMLDialogElement.prototype.close = function close(
      this: HTMLDialogElement,
    ) {
      this.open = false;
    };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the AI connections page", () => {
  it("tells the Admin shell it is the AI connections page", async () => {
    // Payload keeps the breadcrumb in one provider at the Admin root and
    // nothing resets it between views, so a page that sets nothing inherits
    // the last one — which is how this page came to display 社区 / 作品与推荐,
    // a different module entirely.
    vi.stubGlobal("fetch", mockFetch(result()));
    render(createElement(AgentConnectionsClient));
    await waitFor(() => expect(payload.setStepNav).toHaveBeenCalled());
    expect(payload.setStepNav).toHaveBeenCalledWith([
      { label: "发布工具", url: "/admin/editorial-workflow" },
      { label: "AI 连接" },
    ]);
  });

  it("does not disconnect on the first click; it asks", async () => {
    vi.stubGlobal("fetch", mockFetch(result()));
    render(createElement(AgentConnectionsClient));
    const disconnect = await screen.findByText("断开");

    fireEvent.click(disconnect);
    await screen.findByText(/断开 Cursor Desktop/u);
    // THE PROPERTY. Opening the confirmation must not have revoked anything.
    expect(posted).toEqual([]);

    fireEvent.click(screen.getByText("确认断开"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.url).toContain("/api/agent-connections/disconnect");
    expect(posted[0]?.body).toEqual({ id: connection().id });
  });

  it("cancels without disconnecting", async () => {
    vi.stubGlobal("fetch", mockFetch(result()));
    render(createElement(AgentConnectionsClient));
    fireEvent.click(await screen.findByText("断开"));
    await screen.findByText(/断开 Cursor Desktop/u);
    fireEvent.click(screen.getByText("取消"));
    await waitFor(() => expect(screen.queryByText("确认断开")).toBeNull());
    expect(posted).toEqual([]);
  });

  it("leaves no registered client without a way to connect it", async () => {
    // `verification` is a family this page has no setup copy for. The earlier
    // rule hid such a client outside Development, which left a legitimately
    // registered client with no button anywhere on the page.
    vi.stubGlobal("fetch", mockFetch(result({ environment: "production" })));
    render(createElement(AgentConnectionsClient));
    await screen.findByText("连接新应用");
    const others = document.querySelector("[data-agent-connections-others]");
    expect(others).not.toBeNull();
    expect(others?.textContent).toContain("Local verification client");
    expect(
      others?.querySelector("[data-agent-connections-start]"),
    ).not.toBeNull();
  });

  it("shows every registered client exactly once, whatever its family", async () => {
    // The invariant behind the whole grouping change: the preset cards and the
    // overflow card PARTITION the registry. Nothing is listed twice, and
    // nothing falls through the gap between them.
    const families = [
      "cursor",
      "claude",
      "codex",
      "acme-agent",
      "verification",
    ];
    vi.stubGlobal(
      "fetch",
      mockFetch(
        result({
          connections: [],
          clients: families.map((family, index) => ({
            clientId: `client-${index}`,
            family,
            label: `Client ${index}`,
          })),
        }),
      ),
    );
    render(createElement(AgentConnectionsClient));
    await screen.findByText("连接新应用");
    const started = [
      ...document.querySelectorAll("[data-agent-connections-start]"),
    ].map((node) => node.getAttribute("data-agent-connections-start"));
    expect([...started].sort()).toEqual(
      families.map((_, index) => `client-${index}`).sort(),
    );
    for (const family of families)
      expect(
        screen.getAllByText(`Client ${families.indexOf(family)}`),
      ).toHaveLength(1);
  });

  it("gives a second registration in one family its own named button", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        result({
          connections: [],
          clients: [
            {
              clientId: "artvenn-cursor-readonly",
              family: "cursor",
              label: "Cursor Desktop",
            },
            {
              clientId: "artvenn-cursor-second",
              family: "cursor",
              // The harness registers a test identity under `family: "cursor"`
              // exactly like this, so a card that shows only the first one
              // makes the second unreachable and mislabels what it starts.
              label: "Hostname callback client",
            },
          ],
        }),
      ),
    );
    render(createElement(AgentConnectionsClient));
    const card = await waitFor(() => {
      const found = document.querySelector(
        '[data-agent-connections-preset="cursor"]',
      );
      expect(found).not.toBeNull();
      return found as Element;
    });
    // Scoped to the rows, not the card: `Cursor Desktop` is also the card's
    // own heading, so asserting on the card's text passes even when the row
    // has no label at all.
    const labels = [
      ...card.querySelectorAll("[data-agent-connections-client-label]"),
    ].map((label) => label.textContent ?? "");
    expect(labels).toContain("Cursor Desktop");
    expect(labels).toContain("Hostname callback client");

    const second = card.querySelector(
      '[data-agent-connections-start="artvenn-cursor-second"]',
    );
    expect(second).not.toBeNull();
    fireEvent.click(second as Element);
    await waitFor(() => expect(posted).toHaveLength(1));
    // THE PROPERTY. The button starts the registration it is named after.
    expect(posted[0]?.body).toEqual({ clientId: "artvenn-cursor-second" });
  });

  it("does not offer to start a client that is already connected", async () => {
    vi.stubGlobal("fetch", mockFetch(result()));
    render(createElement(AgentConnectionsClient));
    const card = await waitFor(() => {
      const found = document.querySelector(
        '[data-agent-connections-preset="cursor"]',
      );
      expect(found).not.toBeNull();
      return found as Element;
    });
    expect(card.textContent).toContain("已连接");
    expect(
      card.querySelector(
        '[data-agent-connections-start="artvenn-cursor-readonly"]',
      ),
    ).toBeNull();
  });

  it("names the connection in the confirmation, not a fixed product", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        result({
          connections: [
            connection({ client: "acme", clientLabel: "ACME agent" }),
          ],
        }),
      ),
    );
    render(createElement(AgentConnectionsClient));
    fireEvent.click(await screen.findByText("断开"));
    const dialog = await waitFor(() => {
      const found = document.querySelector("[data-agent-connections-confirm]");
      expect(found?.textContent).toContain("ACME agent");
      return found as Element;
    });
    expect(dialog.textContent).not.toContain("Cursor");
    expect(dialog.textContent).toContain("还没过期的令牌");
  });

  it("opens the addresses in place instead of linking off the page", async () => {
    vi.stubGlobal("fetch", mockFetch(result()));
    render(createElement(AgentConnectionsClient));
    const other = await waitFor(() => {
      const found = document.querySelector("[data-agent-connections-other]");
      expect(found).not.toBeNull();
      return found as Element;
    });
    // The guide this used to link to does not exist on `main`.
    expect(other.querySelector("a")).toBeNull();

    const advanced = document.querySelector(
      "[data-agent-connections-advanced]",
    ) as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    fireEvent.click(
      other.querySelector("[data-agent-connections-show-advanced]") as Element,
    );
    await waitFor(() => expect(advanced.open).toBe(true));
    expect(advanced.textContent).toContain("http://localhost:3452/api/mcp");
  });

  it("never calls one client 已连接 and 需要重新授权 on the same screen", async () => {
    // A connection authorized with no grant behind it. The card says
    // 需要重新授权; the preset card used to say 已连接 about the same client,
    // and neither offered a way out.
    vi.stubGlobal(
      "fetch",
      mockFetch(
        result({ connections: [connection({ hasCurrentGrant: false })] }),
      ),
    );
    render(createElement(AgentConnectionsClient));
    const card = await waitFor(() => {
      const found = document.querySelector(
        '[data-agent-connections-preset="cursor"]',
      );
      expect(found).not.toBeNull();
      return found as Element;
    });
    expect(card.textContent).toContain("需要重新授权");
    expect(card.textContent).not.toContain("已连接");
    // And the page says what to do about it, without telling anyone to
    // destroy the connection first.
    const hint = document.querySelector("[data-agent-connection-hint]");
    expect(hint?.textContent).toContain("不需要先断开");
  });

  it("reports the strongest state when one client holds two rows", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        result({
          connections: [
            connection(),
            connection({
              id: "conn-ffffffffffffffffffffffffffffffff",
              status: "awaiting-consent",
              hasCurrentGrant: false,
              consentedAt: null,
              lastVerifiedAt: null,
            }),
          ],
        }),
      ),
    );
    render(createElement(AgentConnectionsClient));
    const card = await waitFor(() => {
      const found = document.querySelector(
        '[data-agent-connections-preset="cursor"]',
      );
      expect(found).not.toBeNull();
      return found as Element;
    });
    // A live connection outranks a half-finished one: saying 等待应用完成授权
    // here would contradict the 已授权 card one row above.
    expect(card.textContent).toContain("已连接");
    expect(card.textContent).not.toContain("等待应用完成授权");
  });

  it("does not offer a button a disconnected client cannot honour", async () => {
    // `resolveConnection` returns early on any existing row, revoked
    // included, so 开始连接 here would succeed and change nothing.
    vi.stubGlobal(
      "fetch",
      mockFetch(
        result({
          connections: [
            connection({
              status: "revoked",
              revokedAt: "2026-09-21T00:02:00.000Z",
              hasCurrentGrant: false,
            }),
          ],
        }),
      ),
    );
    render(createElement(AgentConnectionsClient));
    const card = await waitFor(() => {
      const found = document.querySelector(
        '[data-agent-connections-preset="cursor"]',
      );
      expect(found).not.toBeNull();
      return found as Element;
    });
    expect(
      card.querySelector(
        '[data-agent-connections-start="artvenn-cursor-readonly"]',
      ),
    ).toBeNull();
    expect(card.textContent).toContain("已断开");
    expect(card.textContent).toContain("在应用里重新授权");
  });

  it("treats a revokedAt stamp as a disconnect whatever the status says", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        result({
          connections: [connection({ revokedAt: "2026-09-21T00:02:00.000Z" })],
        }),
      ),
    );
    render(createElement(AgentConnectionsClient));
    // `lifecycle` would refuse this row with CONNECTION_REVOKED; the page must
    // not show it as a live connection needing re-authorization.
    await screen.findByText(/还没有已连接的应用/u);
    const history = document.querySelector("[data-agent-connections-history]");
    expect(history?.textContent).toContain("Cursor Desktop");
    expect(document.querySelector("[data-agent-connection-hint]")).toBeNull();
  });

  it("withholds the recovery hint where consent would refuse it", async () => {
    // Two live rows for one client: `findForClient` raises
    // AMBIGUOUS_CLIENT_CONNECTION and consent fails, so "authorize once more
    // in the application" is a loop that cannot close.
    vi.stubGlobal(
      "fetch",
      mockFetch(
        result({
          connections: [
            connection({ hasCurrentGrant: false }),
            connection({
              id: "conn-ffffffffffffffffffffffffffffffff",
              hasCurrentGrant: false,
            }),
          ],
        }),
      ),
    );
    render(createElement(AgentConnectionsClient));
    expect(await screen.findAllByText("需要重新授权")).not.toHaveLength(0);
    expect(document.querySelector("[data-agent-connection-hint]")).toBeNull();
    // And the badge does not repeat the instruction the hint just withheld:
    // suppressing the explanation while leaving 需要重新授权 standing alone
    // tells the Owner to do the one thing consent will refuse.
    const card = document.querySelector(
      '[data-agent-connections-preset="cursor"]',
    );
    expect(card?.textContent).toContain("多条记录");
    expect(card?.textContent).not.toContain("需要重新授权");
  });

  it("names both rows when a family holds two registrations", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        result({
          connections: [],
          clients: [
            {
              clientId: "artvenn-cursor-readonly",
              family: "cursor",
              label: "Cursor Desktop",
            },
            {
              clientId: "artvenn-cursor-second",
              family: "cursor",
              label: "Hostname callback client",
            },
          ],
        }),
      ),
    );
    render(createElement(AgentConnectionsClient));
    const card = await waitFor(() => {
      const found = document.querySelector(
        '[data-agent-connections-preset="cursor"]',
      );
      expect(found).not.toBeNull();
      return found as Element;
    });
    // Dropping a label that repeats the heading is only safe when there is
    // one row. With two, it leaves an anonymous button beside a named one.
    const rows = [...card.querySelectorAll("[data-agent-connections-start]")];
    expect(rows).toHaveLength(2);
    for (const button of rows)
      expect(
        button.parentElement?.querySelector(
          "[data-agent-connections-client-label]",
        ),
      ).not.toBeNull();
  });

  it("does not offer recovery for a row neither consent branch accepts", async () => {
    // `authorized` with `revokedAt` set: `authorizeConnection` refuses it on
    // `revokedAt`, `reconnectConnection` refuses it on the status column.
    // Nothing can restore it, so the page must not say otherwise.
    vi.stubGlobal(
      "fetch",
      mockFetch(
        result({
          connections: [connection({ revokedAt: "2026-09-21T00:02:00.000Z" })],
        }),
      ),
    );
    render(createElement(AgentConnectionsClient));
    const card = await waitFor(() => {
      const found = document.querySelector(
        '[data-agent-connections-preset="cursor"]',
      );
      expect(found).not.toBeNull();
      return found as Element;
    });
    expect(card.textContent).toContain("已断开");
    expect(card.textContent).toContain("暂时无法在这里重新连上");
    // And the raw status is reachable, because a history row has no 查看详情
    // -- labelled, so it does not read as a second status word competing with
    // the 已断开 badge beside it.
    const history = document.querySelector("[data-agent-connections-history]");
    expect(history?.textContent).toContain("数据库状态：authorized");
  });

  it("counts revoked rows when deciding a pair is ambiguous", async () => {
    // `findForClient` has no status filter: it raises on any two rows for the
    // pair. An Owner who disconnects both halves of a duplicated pair must
    // not be told that re-authorizing brings it back.
    vi.stubGlobal(
      "fetch",
      mockFetch(
        result({
          connections: [
            connection({
              status: "revoked",
              revokedAt: "2026-09-21T00:02:00.000Z",
              hasCurrentGrant: false,
            }),
            connection({
              id: "conn-ffffffffffffffffffffffffffffffff",
              status: "revoked",
              revokedAt: "2026-09-21T00:03:00.000Z",
              hasCurrentGrant: false,
            }),
          ],
        }),
      ),
    );
    render(createElement(AgentConnectionsClient));
    const card = await waitFor(() => {
      const found = document.querySelector(
        '[data-agent-connections-preset="cursor"]',
      );
      expect(found).not.toBeNull();
      return found as Element;
    });
    expect(card.textContent).toContain("暂时无法在这里重新连上");
    expect(card.textContent).not.toContain("重新授权即可");
  });

  it("does not tell the Owner to wait for an authorization that cannot land", async () => {
    // Two live awaiting-consent rows is the shape the consent-page prefetch
    // race produces. `findForClient` refuses the pair, so consent renders
    // CONSENT_UNAVAILABLE and the wait never ends.
    vi.stubGlobal(
      "fetch",
      mockFetch(
        result({
          connections: [
            connection({
              status: "awaiting-consent",
              hasCurrentGrant: false,
              consentedAt: null,
            }),
            connection({
              id: "conn-ffffffffffffffffffffffffffffffff",
              status: "awaiting-consent",
              hasCurrentGrant: false,
              consentedAt: null,
            }),
          ],
        }),
      ),
    );
    render(createElement(AgentConnectionsClient));
    const card = await waitFor(() => {
      const found = document.querySelector(
        '[data-agent-connections-preset="cursor"]',
      );
      expect(found).not.toBeNull();
      return found as Element;
    });
    expect(card.textContent).not.toContain("等待应用完成授权");
    expect(card.textContent).toContain("多条记录");
  });

  it("still reports a live connection beside a revoked one as connected", async () => {
    // The ambiguity blocks future consents; it does not stop the grant that
    // already exists. Gating this too would report a working connection as
    // unavailable.
    vi.stubGlobal(
      "fetch",
      mockFetch(
        result({
          connections: [
            connection(),
            connection({
              id: "conn-ffffffffffffffffffffffffffffffff",
              status: "revoked",
              revokedAt: "2026-09-21T00:02:00.000Z",
              hasCurrentGrant: false,
            }),
          ],
        }),
      ),
    );
    render(createElement(AgentConnectionsClient));
    const card = await waitFor(() => {
      const found = document.querySelector(
        '[data-agent-connections-preset="cursor"]',
      );
      expect(found).not.toBeNull();
      return found as Element;
    });
    expect(card.textContent).toContain("已连接");
    expect(card.textContent).not.toContain("多条记录");
  });

  it("does not promise that two addresses are all it takes", async () => {
    vi.stubGlobal("fetch", mockFetch(result()));
    render(createElement(AgentConnectionsClient));
    const other = await waitFor(() => {
      const found = document.querySelector("[data-agent-connections-other]");
      expect(found).not.toBeNull();
      return found as Element;
    });
    // `resolveConnection` refuses CLIENT_NOT_REGISTERED for a client id this
    // deployment has not been configured with, and there is no self-service
    // registration endpoint. The card has to say so.
    expect(other.textContent).toContain("登记");
    expect(other.textContent).not.toContain("授权即可");
  });

  it("names the confirmation dialog for assistive technology", async () => {
    vi.stubGlobal("fetch", mockFetch(result()));
    render(createElement(AgentConnectionsClient));
    fireEvent.click(await screen.findByText("断开"));
    const dialog = await waitFor(() => {
      const found = document.querySelector("[data-agent-connections-confirm]");
      expect(found?.getAttribute("aria-labelledby")).toBeTruthy();
      return found as Element;
    });
    const titleId = dialog.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(titleId)?.textContent).toContain(
      "Cursor Desktop",
    );
  });

  it("stops saying 已复制 once the moment has passed", async () => {
    vi.stubGlobal("fetch", mockFetch(result()));
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(createElement(AgentConnectionsClient));
    await waitFor(() =>
      expect(document.querySelector("[data-agent-connection]")).not.toBeNull(),
    );
    fireEvent.click(screen.getByText("查看详情"));
    fireEvent.click(screen.getAllByText("复制")[0] as Element);
    await waitFor(() =>
      expect(screen.queryAllByText("已复制")).toHaveLength(1),
    );
    // Real timers: the reset is a 1500ms timeout inside the component, and a
    // fake-timer run here would pass without the component ever scheduling it.
    await waitFor(() => expect(screen.queryByText("已复制")).toBeNull(), {
      timeout: 4000,
    });
  });

  it("does not call a connection authorized when nothing is behind it", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        result({ connections: [connection({ hasCurrentGrant: false })] }),
      ),
    );
    render(createElement(AgentConnectionsClient));
    expect(await screen.findAllByText("需要重新授权")).toHaveLength(2);
    expect(screen.queryByText("已授权")).toBeNull();
  });

  it("moves a revoked connection out of the primary list into history", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        result({
          connections: [
            connection({
              status: "revoked",
              revokedAt: "2026-09-21T00:02:00.000Z",
              hasCurrentGrant: false,
            }),
          ],
        }),
      ),
    );
    render(createElement(AgentConnectionsClient));
    await screen.findByText(/还没有已连接的应用/u);
    const history = document.querySelector("[data-agent-connections-history]");
    expect(history?.textContent).toContain("Cursor Desktop");
    expect(history?.textContent).toContain("已断开");
  });

  it("shows no identifier in the primary row until details are opened", async () => {
    vi.stubGlobal("fetch", mockFetch(result()));
    render(createElement(AgentConnectionsClient));
    const card = await waitFor(() => {
      const found = document.querySelector("[data-agent-connection]");
      expect(found).not.toBeNull();
      return found as Element;
    });
    expect(card.textContent).not.toContain("artvenn-cursor-readonly");
    expect(card.textContent).not.toContain("agent-cursor-0123456789ab");

    fireEvent.click(screen.getByText("查看详情"));
    await waitFor(() =>
      expect(
        document.querySelector("[data-agent-connection]")?.textContent,
      ).toContain("artvenn-cursor-readonly"),
    );
  });
});

/**
 * The login door's pages, for an administrator who may know little about computers.
 * The real pages over real sessions are in `tests/cms/agent-connections-browser.mjs`.
 */
const HOSTED_CLIENT = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const LOCAL_CLIENT = "https://chatgpt.com/oauth/codex/client.json";
const RESOURCE = "https://admin.example.test/api/mcp";
const UID = "uid-0123456789";
const REVIEW = `/admin/agent-connections/consent?interaction=${UID}`;
const LOGIN = `/admin/login?redirect=${encodeURIComponent(REVIEW)}`;
const COOKIE = "payload-token=synthetic";
const PERSON = "someone@editorial.example.invalid";
const syntheticTicket = () => "ab".repeat(32);
const connectionTokenHeader = () =>
  ["Bearer", `artvenn_ct_${"c".repeat(32)}`].join(" ");

const hostedTool = {
  label: "Claude",
  vendor: "Anthropic",
  callbackHosts: ["claude.ai"],
  local: false,
};
const localTool = {
  label: "Codex",
  vendor: "OpenAI",
  callbackHosts: ["127.0.0.1", "localhost"],
  local: true,
};

const displayed = {
  interaction: UID,
  resource: RESOURCE,
  environment: "synthetic",
  protocol: ["offline_access"],
  expiresAt: "2026-11-05T00:30:00.000Z",
};

const operatorDisplay = (tool: typeof hostedTool) => ({
  ...displayed,
  client: tool.local ? LOCAL_CLIENT : HOSTED_CLIENT,
  capabilities: ["artvenn:admin"],
  preset: "operator" as const,
  tool,
});

const consentPage = (tool: typeof hostedTool) => {
  render(
    createElement(AgentConsentClient, {
      display: operatorDisplay(tool),
      person: PERSON,
      ticket: syntheticTicket(),
    }),
  );
  return document.querySelector("[data-agent-consent]") as HTMLElement;
};

describe("the consent page under the login door", () => {
  it("says what the tool can do, before the click", () => {
    const text = consentPage(hostedTool).textContent ?? "";
    expect(text).toContain("「Claude」想连接由于艺后台");
    expect(text).toContain("「AI 操作账号」");
    expect(text).toContain("不用你逐条确认");
    for (const power of [
      "查看和修改内容",
      "审核",
      "发布",
      "处理举报和申诉",
      "封禁用户",
      "查看数据",
    ])
      expect(text).toContain(power);
    expect(text).toContain("发送给 Claude 的提供方 Anthropic");
  });

  it("says what the tool cannot do", () => {
    const text = consentPage(hostedTool).textContent ?? "";
    for (const limit of [
      "管理账号和密钥",
      "动暂停开关",
      "看或改操作记录",
      "改敏感开关",
    ])
      expect(text).toContain(limit);
    expect(text).toMatch(/它不能：/u);
  });

  it("names the person on the record, and who can stop it", () => {
    const text = consentPage(hostedTool).textContent ?? "";
    expect(text).toContain(`写明是你（${PERSON}）授权的`);
    expect(text).toContain("你和其他管理员随时可以在「AI 连接」页断开");
  });

  it("shows where a hosted tool's browser returns", () => {
    const line = consentPage(hostedTool).querySelector(
      "[data-agent-consent-return]",
    );
    expect(line?.textContent).toBe("授权完成后，浏览器会回到：claude.ai");
  });

  it("says a local tool returns to this computer, and names its hostnames", () => {
    const line = consentPage(localTool).querySelector(
      "[data-agent-consent-return]",
    );
    expect(line?.textContent).toContain("这台电脑上的程序");
    // The amendment and the Matrix ask for the hostname, loopback included.
    expect(line?.textContent).toContain("127.0.0.1");
    expect(line?.textContent).toContain("localhost");
    expect(line?.textContent).not.toContain("claude.ai");
  });

  it("tells them to allow only what they started themselves", () => {
    const text = consentPage(hostedTool).textContent ?? "";
    expect(text).toContain(
      "只有你刚刚自己在这个工具里点了「连接」，才点允许。如果是别人发来的链接，请点拒绝。",
    );
  });

  it.each([hostedTool, localTool])(
    "puts no client id, URL or scope on screen for $label, only in data attributes",
    (tool) => {
      const section = consentPage(tool);
      const text = section.textContent ?? "";
      for (const raw of [
        HOSTED_CLIENT,
        LOCAL_CLIENT,
        RESOURCE,
        "http",
        "artvenn:admin",
        "offline_access",
        "2026-11-05",
        UID,
      ])
        expect(text).not.toContain(raw);
      expect(section.getAttribute("data-agent-consent-client")).toBe(
        tool.local ? LOCAL_CLIENT : HOSTED_CLIENT,
      );
      expect(section.getAttribute("data-agent-consent-resource")).toBe(
        RESOURCE,
      );
      expect(section.getAttribute("data-agent-consent-scopes")).toBe(
        "artvenn:admin",
      );
      expect(section.getAttribute("data-agent-consent-callback-hosts")).toBe(
        tool.callbackHosts.join(" "),
      );
    },
  );

  it("puts no stray space between Chinese sentences", () => {
    // JSX turns a line break into a space. Seen on the first screenshots.
    expect(consentPage(hostedTool).textContent).not.toMatch(/[。：，]\s/u);
  });

  it("sends the decision the person clicked, with the ticket, and refuses plainly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { body?: string }) => {
        posted.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
        return {
          ok: false,
          json: async () => ({ ok: false, error: "CONSENT_NOT_DECIDABLE" }),
        } as unknown as Response;
      }),
    );
    consentPage(hostedTool);
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    const alert = await screen.findByRole("alert");
    expect(posted).toEqual([
      {
        url: "/api/agent-connections/consent",
        body: {
          interaction: UID,
          ticket: syntheticTicket(),
          decision: "deny",
        },
      },
    ]);
    // One sentence in the person's words, and the code small beside it.
    expect(alert.textContent).toContain(
      "这次连接没有完成，请回到工具重新点连接。",
    );
    expect(alert.querySelector("small")?.textContent).toBe(
      "CONSENT_NOT_DECIDABLE",
    );
  });

  it("keeps 允许 waiting a moment each time the page is shown and focused", () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        async () =>
          ({
            ok: false,
            json: async () => ({ ok: false, error: "CONSENT_NOT_DECIDABLE" }),
          }) as unknown as Response,
      );
      vi.stubGlobal("fetch", fetchMock);
      consentPage(hostedTool);
      const allow = screen.getByRole("button", { name: "允许" });
      // Not before the page has focus: jsdom's document has it once an element does.
      expect(allow.getAttribute("aria-disabled")).toBe("true");
      act(() => {
        allow.focus();
        window.dispatchEvent(new Event("focus"));
      });
      fireEvent.click(allow);
      act(() => void vi.advanceTimersByTime(999));
      expect(allow.getAttribute("aria-disabled")).toBe("true");
      expect(fetchMock).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(1));
      expect(allow.getAttribute("aria-disabled")).toBeNull();

      // Each switch starts it again, and a click or key that comes with it does
      // nothing. Focus stays on the button, so a keyboard user loses no place.
      for (const switched of [
        () => window.dispatchEvent(new Event("focus")),
        () => document.dispatchEvent(new Event("visibilitychange")),
      ]) {
        act(switched);
        fireEvent.click(allow);
        expect(allow.getAttribute("aria-disabled")).toBe("true");
        expect(document.activeElement).toBe(allow);
        act(() => void vi.advanceTimersByTime(1000));
      }
      expect(fetchMock).not.toHaveBeenCalled();
      fireEvent.click(allow);
      expect(fetchMock).toHaveBeenCalledOnce();
      // 拒绝 never waits.
      expect(
        screen
          .getByRole("button", { name: "拒绝" })
          .hasAttribute("aria-disabled"),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the Development read-only page as its harness reads it", () => {
    render(
      createElement(AgentConsentClient, {
        display: {
          ...displayed,
          client: HOSTED_CLIENT,
          preset: "read-only",
          capabilities: ["artvenn:read"],
        },
        person: PERSON,
        ticket: syntheticTicket(),
      }),
    );
    expect(
      document.querySelector("[data-agent-consent-client]")?.textContent,
    ).toBe(HOSTED_CLIENT);
    expect(screen.getByRole("button", { name: "同意" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "允许" })).toBeNull();
  });
});

const viewProps = (
  user: Record<string, unknown> | null,
  headers: Record<string, string> = { cookie: COOKIE },
  searchParams: Record<string, string> = { interaction: UID },
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
    searchParams,
  }) as unknown as AdminViewServerProps;

const humanOwner = {
  collection: "users",
  id: 7,
  email: PERSON,
  role: "owner",
  _strategy: "local-jwt",
};

/** What the Admin's consent runtime answers, with the writes recorded. */
const stubRuntime = (row: Record<string, unknown> = {}) => {
  const runtime = {
    preset: "operator",
    environment: "synthetic",
    resource: RESOURCE,
    clients: new Map([
      [
        HOSTED_CLIENT,
        {
          clientId: HOSTED_CLIENT,
          family: "claude",
          label: "Claude",
          callbackPolicy: "hosted-https",
          redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
        },
      ],
    ]),
    consents: {
      read: vi.fn(async () => ({
        interactionUid: UID,
        oauthClientId: HOSTED_CLIENT,
        resource: RESOURCE,
        capabilityScopes: ["artvenn:admin"],
        protocolScopes: ["offline_access"],
        preset: "operator",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        decision: null,
        ...row,
      })),
      arm: vi.fn(async () => ({ interactionUid: UID })),
    },
    connections: {
      findForClient: vi.fn(async () => ({
        connection: { id: "conn-0123456789abcdef0123456789abcdef" },
      })),
      createForClient: vi.fn(),
    },
  };
  payload.consentRuntime.mockReturnValue(runtime);
  return runtime;
};

const operatorSurface = () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ADMIN_MCP_OAUTH_ENABLED", "true");
};

const renderConsent = async (props: AdminViewServerProps) =>
  renderToStaticMarkup(await AgentConsentView(props));

describe("the review view's gate", () => {
  beforeEach(() => {
    payload.consentRuntime.mockReset();
    operatorSurface();
  });

  it("sends a browser with no session to the login page, and back to this interaction", async () => {
    const runtime = stubRuntime();
    await expect(
      AgentConsentView(viewProps(null, {}, { interaction: UID })),
    ).rejects.toThrow(`REDIRECT ${LOGIN}`);
    expect(runtime.consents.arm).not.toHaveBeenCalled();
  });

  it("does the same for an expired session's leftover cookie", async () => {
    stubRuntime();
    await expect(AgentConsentView(viewProps(null))).rejects.toThrow(
      `REDIRECT ${LOGIN}`,
    );
  });

  it("carries no unchecked value into the login address", async () => {
    stubRuntime();
    const html = await renderConsent(
      viewProps(null, {}, { interaction: "https://evil.example/x" }),
    );
    expect(html).toContain("只有管理员账号可以使用这一页。");
    expect(html).not.toContain("evil.example");
  });

  it("does not offer a login while the door is off", async () => {
    vi.stubEnv("ADMIN_MCP_OAUTH_ENABLED", "false");
    payload.consentRuntime.mockReturnValue(null);
    const html = await renderConsent(viewProps(null, {}));
    expect(html).toContain("只有管理员账号可以使用这一页。");
  });

  it.each([
    [
      "a connection token",
      null,
      { cookie: COOKIE, authorization: connectionTokenHeader() },
    ],
    [
      "an MCP key on the owner row",
      { ...humanOwner, _strategy: "mcp-api-key" },
      { cookie: COOKIE },
    ],
    [
      "an ai_operator key",
      { ...humanOwner, role: "ai_operator", _strategy: "mcp-api-key" },
      { cookie: COOKIE },
    ],
    [
      "a connection on the ai_operator row",
      { ...humanOwner, role: "ai_operator", _strategy: "mcp-connection" },
      { cookie: COOKIE },
    ],
    [
      "an automation session",
      { ...humanOwner, role: "automation" },
      { cookie: COOKIE },
    ],
    [
      "an Owner REST key",
      { ...humanOwner, _strategy: "api-key" },
      { cookie: COOKIE },
    ],
    [
      "an Owner token in a header",
      humanOwner,
      { cookie: COOKIE, authorization: "JWT synthetic" },
    ],
    ["an Owner token with no cookie", humanOwner, {}],
  ])("refuses %s: no login page, no ticket armed", async (_, user, headers) => {
    const runtime = stubRuntime();
    const html = await renderConsent(viewProps(user, headers));
    expect(html).toContain("只有管理员账号可以使用这一页。");
    expect(html).not.toContain("data-agent-consent=");
    expect(runtime.consents.read).not.toHaveBeenCalled();
    expect(runtime.consents.arm).not.toHaveBeenCalled();
    expect(runtime.connections.findForClient).not.toHaveBeenCalled();
  });

  it("arms once for an Owner browser session, stamped as the door reads it", async () => {
    const runtime = stubRuntime();
    const html = await renderConsent(viewProps(humanOwner));
    expect(runtime.consents.arm).toHaveBeenCalledOnce();
    expect(runtime.consents.arm).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionUid: UID,
        humanAccountId: "payload-user-7",
      }),
    );
    expect(html).toContain("「Claude」想连接由于艺后台");
    expect(html).toContain(PERSON);
  });

  it.each([
    ["a spent interaction", { decision: "approved" }],
    ["a tool off the list", { oauthClientId: "https://other.example/client" }],
    ["another resource", { resource: "https://other.example/api/mcp" }],
    ["another preset", { preset: "read-only" }],
  ])("refuses %s in a sentence, with nothing armed", async (_, row) => {
    const runtime = stubRuntime(row);
    const html = await renderConsent(viewProps(humanOwner));
    expect(html).toContain("这次连接没有完成");
    expect(html).toContain("请回到工具重新点连接。");
    expect(html).toContain("data-agent-consent-refused");
    expect(runtime.consents.arm).not.toHaveBeenCalled();
  });

  it.each(["approved", "denied"])(
    "tells the person who decided (%s) that it was handled, after Back or a refresh",
    async (decision) => {
      const runtime = stubRuntime({
        decision,
        humanAccountId: "payload-user-7",
      });
      const html = await renderConsent(viewProps(humanOwner));
      expect(html).toContain("这次请求已经处理过了");
      expect(html).toContain("是否已连上，请到");
      expect(html).toContain('href="/admin/agent-connections"');
      expect(html).not.toContain("这次连接没有完成");
      expect(html).not.toContain("data-agent-consent-refused");
      expect(runtime.consents.arm).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["another owner's decision", "payload-user-8", "operator"],
    ["a decision under the read-only profile", "payload-user-7", "read-only"],
  ])(
    "keeps the refusal for %s, so it tells a prober nothing",
    async (_, decidedBy, preset) => {
      const runtime = stubRuntime({
        decision: "approved",
        humanAccountId: decidedBy,
      });
      runtime.preset = preset;
      const html = await renderConsent(viewProps(humanOwner));
      expect(html).toContain(
        'data-agent-consent-refused="INTERACTION_NOT_AVAILABLE"',
      );
      expect(html).not.toContain("这次请求已经处理过了");
      expect(runtime.consents.arm).not.toHaveBeenCalled();
    },
  );

  it("keeps its sentence when the runtime refused to build", async () => {
    payload.consentRuntime.mockImplementation(() => {
      throw new Error("consent runtime refused: CONSENT_DATABASE_REQUIRED");
    });
    const html = await renderConsent(viewProps(humanOwner));
    expect(html).toContain('data-agent-consent-refused="CONSENT_UNAVAILABLE"');
    expect(html).toContain("请回到工具重新点连接。");
  });
});

describe("the AI connections view's gate", () => {
  const renderPage = (props: AdminViewServerProps) =>
    renderToStaticMarkup(AgentConnectionsView(props));

  it("shows the slim page to an Owner browser session under operator", () => {
    operatorSurface();
    const html = renderPage(viewProps(humanOwner));
    expect(html).toContain("已连接的工具");
    expect(html).not.toContain("连接新应用");
  });

  it("keeps the Development page under the read-only profile", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AGENT_CONNECTIONS_ENABLED", "true");
    const html = renderPage(viewProps(humanOwner));
    expect(html).toContain("连接新应用");
    expect(html).not.toContain("已连接的工具");
  });

  it("says the feature is off, and shows nothing else, while the door is off", () => {
    vi.stubEnv("NODE_ENV", "production");
    const html = renderPage(viewProps(humanOwner));
    expect(html).toContain("AI 连接未启用。");
    expect(html).not.toContain("已连接的工具");
  });

  it("sends a browser with no session to the login page", () => {
    operatorSurface();
    expect(() => renderPage(viewProps(null, {}))).toThrow(
      `REDIRECT /admin/login?redirect=${encodeURIComponent("/admin/agent-connections")}`,
    );
  });

  it.each([
    [
      "a connection token",
      null,
      { cookie: COOKIE, authorization: connectionTokenHeader() },
    ],
    ["a key", { ...humanOwner, _strategy: "mcp-api-key" }, { cookie: COOKIE }],
    [
      "an automation session",
      { ...humanOwner, role: "automation" },
      { cookie: COOKIE },
    ],
  ])("refuses %s", (_, user, headers) => {
    operatorSurface();
    const html = renderPage(viewProps(user, headers));
    expect(html).toContain("只有管理员账号可以使用这一页。");
    expect(html).not.toContain("已连接的工具");
  });
});

describe("the consent landing", () => {
  const landing = async (uid = UID) =>
    renderToStaticMarkup(
      await ConsentLandingPage({ params: Promise.resolve({ uid }) }),
    );

  it("goes on by itself under operator, and keeps a plain link", async () => {
    operatorSurface();
    payload.consentRuntime.mockReset();
    const html = await landing();
    expect(payload.consentRuntime).not.toHaveBeenCalled();
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain(`content="0;url=${REVIEW}"`);
    expect(html).toContain(`data-agent-consent-landing="${UID}"`);
    expect(html).toMatch(
      new RegExp(
        `<a [^>]*data-agent-consent-continue[^>]*href="${REVIEW.replace("?", "\\?")}"`,
        "u",
      ),
    );
    expect(html).toContain("这一页不会授权任何事情");
  });

  it("keeps the click the Development read-only profile measured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AGENT_CONNECTIONS_ENABLED", "true");
    const html = await landing();
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).toContain("data-agent-consent-continue");
  });

  it("is absent while the door is off", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(landing()).rejects.toThrow("NOT_FOUND");
  });

  it("refuses a uid that is not an opaque identifier", async () => {
    operatorSurface();
    await expect(landing('x"><script>')).rejects.toThrow("NOT_FOUND");
  });

  it("imports nothing that could read a database or a session", () => {
    // A landing reached by a cross-site redirect reads nothing, and a Next `Link`
    // would prefetch the page behind it, which arms a ticket.
    const source = readFileSync(
      new URL(
        "../../../apps/admin/app/(agent-connections)/agent-connections/consent/[uid]/page.tsx",
        `file://${import.meta.dirname}/`,
      ),
      "utf8",
    );
    const imports = source.match(/from "[^"]+"/gu) ?? [];
    expect(imports.join(" ")).not.toMatch(
      /next\/link|runtime|resource|access/u,
    );
  });
});

const listed = (overrides: Record<string, unknown> = {}) => ({
  id: "conn-0123456789abcdef0123456789abcdef",
  family: "claude",
  tool: "Claude",
  authorizedBy: "other@editorial.example.invalid",
  mine: false,
  consentedAt: "2026-11-04T00:00:00.000Z",
  lastVerifiedAt: "2026-11-04T01:00:00.000Z",
  ...overrides,
});

const operatorList = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  result: {
    preset: "operator",
    resource: RESOURCE,
    clients: [
      { family: "claude", label: "Claude" },
      { family: "claude-code", label: "Claude Code" },
      { family: "codex", label: "Codex" },
      { family: "chatgpt", label: "ChatGPT" },
    ],
    connections: [listed()],
    ...overrides,
  },
});

describe("the AI connections page under the login door", () => {
  const ADDRESS = "https://public.example.test/api/mcp";
  const mount = async (body: unknown, address: string | null = ADDRESS) => {
    vi.stubGlobal("fetch", mockFetch(body));
    render(createElement(OperatorConnectionsClient, { address }));
    await waitFor(() =>
      expect(
        document
          .querySelector("[data-agent-connections]")
          ?.getAttribute("data-agent-connections-resource"),
      ).toBe(RESOURCE),
    );
  };

  it("lists every connection with who authorized it, when, and when last used", async () => {
    await mount(
      operatorList({
        connections: [
          listed(),
          listed({
            id: "conn-ffffffffffffffffffffffffffffffff",
            family: "codex",
            tool: "Codex",
            authorizedBy: PERSON,
            mine: true,
            lastVerifiedAt: null,
          }),
        ],
      }),
    );
    const rows = [...document.querySelectorAll("[data-agent-connection]")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Claude");
    expect(rows[0]?.textContent).toContain("other@editorial.example.invalid");
    expect(rows[1]?.textContent).toContain(`${PERSON}（你）`);
    expect(rows[1]?.textContent).toContain("还没用过");
    // Header cells name the same five columns the record promises.
    expect(
      [...document.querySelectorAll("th")].map((cell) => cell.textContent),
    ).toEqual(["工具", "授权人", "授权时间", "最近使用", "操作"]);
    // An observation, never a claim that anything is online.
    expect(document.body.textContent).not.toContain("在线");
  });

  it("asks first, then disconnects anyone's connection", async () => {
    await mount(operatorList());
    fireEvent.click(screen.getByRole("button", { name: /^断开「Claude」/u }));
    await screen.findByText("断开「Claude」？");
    expect(posted).toEqual([]);
    fireEvent.click(screen.getByText("确认断开"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      url: "/api/agent-connections/disconnect",
      body: { id: listed().id },
    });
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("已断开「Claude」。");
    // The button that opened the dialog may be gone with its row: focus goes on
    // to the list rather than falling back to the page.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("已连接的工具"),
    );
  });

  it("names whose tool each disconnect button stops", async () => {
    await mount(
      operatorList({
        connections: [
          listed(),
          listed({
            id: "conn-ffffffffffffffffffffffffffffffff",
            authorizedBy: PERSON,
            mine: true,
          }),
          listed({
            id: "conn-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            tool: null,
            authorizedBy: null,
          }),
        ],
      }),
    );
    expect(
      screen
        .getAllByRole("button", { name: /^断开/u })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "断开「Claude」，授权人：other@editorial.example.invalid",
      `断开「Claude」，授权人：${PERSON}（你）`,
      "断开「已不在清单中的工具」，授权人：账号已不存在",
    ]);
  });

  it("does not disconnect on cancel", async () => {
    await mount(operatorList());
    fireEvent.click(screen.getByRole("button", { name: /^断开「Claude」/u }));
    await screen.findByText("断开「Claude」？");
    fireEvent.click(screen.getByText("取消"));
    await waitFor(() => expect(screen.queryByText("确认断开")).toBeNull());
    expect(posted).toEqual([]);
  });

  it("can still stop a tool that left the list, or whose person is gone", async () => {
    await mount(
      operatorList({
        connections: [listed({ tool: null, authorizedBy: null })],
      }),
    );
    expect(document.body.textContent).toContain("已不在清单中的工具");
    expect(document.body.textContent).toContain("账号已不存在");
    expect(
      screen.getByRole("button", { name: /^断开「已不在清单中的工具」/u }),
    ).toBeTruthy();
  });

  it("builds the Claude button from this deployment's address, never a fixed one", async () => {
    await mount(operatorList());
    const link = new URL(
      document
        .querySelector("[data-agent-connections-claude]")
        ?.getAttribute("href") ?? "",
    );
    expect(link.origin).toBe("https://claude.ai");
    expect(link.pathname).toBe("/customize/connectors");
    expect(link.searchParams.get("modal")).toBe("add-custom-connector");
    expect(link.searchParams.get("connectorName")).toBe("由于艺后台");
    expect(link.searchParams.get("connectorUrl")).toBe(ADDRESS);
    const team = new URL(
      document
        .querySelector("[data-agent-connections-claude-team]")
        ?.getAttribute("href") ?? "",
    );
    expect(team.pathname).toBe("/admin-settings/connectors");
    expect(team.searchParams.get("connectorUrl")).toBe(ADDRESS);
  });

  it("shows the address with a copy button", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await mount(operatorList());
    const row = document.querySelector("[data-agent-connections-address]");
    expect(row?.textContent).toContain(ADDRESS);
    fireEvent.click(
      Array.from(row?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent === "复制",
      ) as Element,
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ADDRESS));
  });

  it("falls back to the list's resource if the deployment names no address", async () => {
    await mount(operatorList(), null);
    expect(
      document.querySelector("[data-agent-connections-address]")?.textContent,
    ).toContain(RESOURCE);
  });

  it("gives short steps for other tools, only those on the closed list", async () => {
    await mount(
      operatorList({
        clients: [
          { family: "claude-code", label: "Claude Code" },
          { family: "chatgpt", label: "ChatGPT" },
        ],
      }),
    );
    const families = [
      ...document.querySelectorAll("[data-agent-connections-steps]"),
    ].map((node) => node.getAttribute("data-agent-connections-steps"));
    expect(families).toEqual(["claude-code", "chatgpt"]);
    expect(
      document.querySelector("[data-agent-connections-claude]"),
    ).toBeNull();
    // User scope, so the tool finds it from whichever folder it starts in.
    expect(
      document.querySelector('[data-agent-connections-steps="claude-code"]')
        ?.textContent,
    ).toContain(
      `claude mcp add --transport http --scope user artvenn ${ADDRESS}`,
    );
    for (const list of document.querySelectorAll(
      "[data-agent-connections-steps] ol",
    ))
      expect(list.children.length).toBe(3);
  });

  it("gives Codex the name step, and a terminal path with each command to copy", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await mount(operatorList());
    const card = document.querySelector(
      '[data-agent-connections-steps="codex"]',
    );
    expect(card?.querySelector("ol")?.children[0]?.textContent).toContain(
      "填一个名字（例如 artvenn），选 Streamable HTTP",
    );
    const terminal = card?.querySelector(
      '[data-agent-connections-terminal="codex"]',
    );
    expect(terminal?.children.length).toBe(3);
    const commands = [
      `codex mcp add artvenn --url ${ADDRESS}`,
      "codex mcp login artvenn",
    ];
    for (const command of commands)
      expect(terminal?.textContent).toContain(command);
    for (const button of terminal?.querySelectorAll("button") ?? [])
      fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenNthCalledWith(1, commands[0]);
    expect(writeText).toHaveBeenNthCalledWith(2, commands[1]);
  });

  it("points to the pause switch, and offers a person no key", async () => {
    await mount(operatorList());
    const pause = document.querySelector("[data-agent-connections-pause]");
    expect(pause?.textContent).toContain("暂停");
    expect(pause?.querySelector("a")?.getAttribute("href")).toBe(
      "/admin/mcp-control",
    );
    expect(document.body.textContent).toContain("不需要密钥");
    expect(
      document.querySelector('a[href*="payload-mcp-api-keys"]'),
    ).toBeNull();
  });

  it("says a refused read in a sentence, with the code small", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            json: async () => ({ ok: false, error: "OWNER_ONLY" }),
          }) as unknown as Response,
      ),
    );
    render(createElement(OperatorConnectionsClient, { address: ADDRESS }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("需要管理员登录");
    expect(alert.querySelector("small")?.textContent).toBe("OWNER_ONLY");
  });

  it("says it plainly when there is nothing connected", async () => {
    await mount(operatorList({ connections: [] }));
    expect(
      document.querySelector("[data-agent-connections-empty]")?.textContent,
    ).toBe("还没有连接任何工具。");
  });
});

describe("the notice to the other owners", () => {
  const mount = (body: unknown) => {
    vi.stubGlobal("fetch", mockFetch(body));
    return render(createElement(NewConnectionNotice));
  };

  beforeEach(() => {
    payload.getPreference.mockReset();
    payload.setPreference.mockReset();
    payload.getPreference.mockResolvedValue(null);
  });

  it("tells an owner what another owner connected, on their next visit", async () => {
    mount(operatorList());
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain(
      "other@editorial.example.invalid 授权了「Claude」",
    );
    expect(notice.querySelector("a")?.getAttribute("href")).toBe(
      "/admin/agent-connections",
    );
  });

  it("says nothing about a person's own connection", async () => {
    mount(operatorList({ connections: [listed({ mine: true })] }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("status")).toBeNull();
    // Nothing to compare, so the preference is not even read.
    expect(payload.getPreference).not.toHaveBeenCalled();
  });

  it("says nothing the person has already seen", async () => {
    payload.getPreference.mockResolvedValue({
      seenAt: "2026-11-04T00:00:00.000Z",
    });
    mount(operatorList());
    await waitFor(() => expect(payload.getPreference).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("tells of a later connection, and of a reconnect, past what was seen", async () => {
    payload.getPreference.mockResolvedValue({
      seenAt: "2026-11-03T00:00:00.000Z",
    });
    mount(
      operatorList({
        connections: [
          listed(),
          listed({
            id: "conn-ffffffffffffffffffffffffffffffff",
            tool: "ChatGPT",
            authorizedBy: "third@editorial.example.invalid",
            consentedAt: "2026-11-04T09:00:00.000Z",
          }),
          listed({
            id: "conn-00000000000000000000000000000000",
            tool: "Codex",
            consentedAt: "2026-11-02T00:00:00.000Z",
          }),
        ],
      }),
    );
    const notice = await screen.findByRole("status");
    expect(notice.getAttribute("data-agent-connections-notice")).toBe("2");
    expect(notice.textContent).toContain("有 2 个新的 AI 连接");
    expect(notice.textContent).toContain(
      "third@editorial.example.invalid 授权的「ChatGPT」",
    );
  });

  it("remembers the newest one once dismissed", async () => {
    mount(
      operatorList({
        connections: [
          listed(),
          listed({
            id: "conn-ffffffffffffffffffffffffffffffff",
            consentedAt: "2026-11-04T09:00:00.000Z",
          }),
        ],
      }),
    );
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(payload.setPreference).toHaveBeenCalledWith(
      "agent-connections-seen",
      { seenAt: "2026-11-04T09:00:00.000Z" },
    );
  });

  it("shows nothing when the list cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("synthetic network failure");
      }),
    );
    render(createElement(NewConnectionNotice));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows nothing under the read-only profile, whose rows carry no `mine`", async () => {
    mount(result());
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
