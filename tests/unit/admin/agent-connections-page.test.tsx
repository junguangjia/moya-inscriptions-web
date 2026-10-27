// @vitest-environment jsdom
import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    setStepNav: vi.fn(),
  };
});
vi.mock(payload.ui, () => ({
  // Records the breadcrumb instead of rendering it, so the page's claim about
  // its own location is assertable here rather than only in a browser.
  SetStepNav: ({ nav }: { readonly nav: readonly { label: string }[] }) => {
    payload.setStepNav(nav);
    return null;
  },
}));

import { AgentConnectionsClient } from "admin/agent-connections-client";

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
