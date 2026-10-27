// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const paths = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const { join } = await import("node:path");
  const req = createRequire(join(import.meta.dirname, "../../../apps/admin/"));
  return { ui: realpathSync(req.resolve("@payloadcms/ui")) };
});
vi.mock(paths.ui, () => ({
  SetStepNav: () => null,
  Gutter: ({ children }: { children: ReactNode }) => children,
  Button: ({
    children,
    buttonStyle,
    ...props
  }: {
    children: ReactNode;
    buttonStyle?: string;
  }) =>
    createElement(
      "button",
      { ...props, "data-button-style": buttonStyle },
      children,
    ),
}));
import { OwnerWorkflowClient } from "admin/owner-workflow-client";
const page = {
  docs: [
    {
      id: 7,
      revision: 4,
      title: "Synthetic catalog",
      catalogId: "catalog-synthetic",
      status: "draft",
      changedFields: ["title"],
      missingFields: [],
    },
  ],
  page: 1,
  totalPages: 1,
  totalDocs: 1,
  automationUsers: [{ id: 11, label: "Synthetic executor" }],
};
const response = (result: unknown) => ({
  ok: true,
  json: async () => ({ ok: true, result }),
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Owner editorial task presentation", () => {
  it("requires a review confirmation and sends only the selected exact revision to the chosen executor", async () => {
    const fetch = vi.fn(async (url: string) =>
      response(
        url.endsWith("owner-drafts") ? page : { approvalId: 2, itemCount: 1 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(createElement(OwnerWorkflowClient));
    await screen.findByText("Synthetic catalog");
    fireEvent.click(screen.getByLabelText("选择 Synthetic catalog"));
    fireEvent.change(screen.getByLabelText("执行账号"), {
      target: { value: "11" },
    });
    fireEvent.click(screen.getByRole("button", { name: "核对并批准…" }));
    expect(
      fetch.mock.calls.filter(([url]) => url.endsWith("approve-batch")),
    ).toHaveLength(0);
    const confirmation = screen.getByRole("group", { name: "确认批次批准" });
    expect(confirmation.textContent).toContain("Synthetic executor");
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "返回修改" }),
    );
    expect(
      fetch.mock.calls.filter(([url]) => url.endsWith("approve-batch")),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "核对并批准…" }));
    fireEvent.click(screen.getByRole("button", { name: "确认批准" }));
    await screen.findByText(/已批准批次/);
    const call = fetch.mock.calls.find(([url]) =>
      url.endsWith("approve-batch"),
    );
    expect(
      JSON.parse((call as unknown as [string, RequestInit])[1].body as string),
    ).toEqual({ automationUserId: 11, items: [{ id: 7, revision: 4 }] });
  });

  it("opens history as a peer task and restores with the observed current revision", async () => {
    const fetch = vi.fn(async (url: string) =>
      response(
        url.endsWith("owner-drafts")
          ? page
          : url.endsWith("owner-history")
            ? {
                id: 7,
                currentRevision: 4,
                page: 1,
                totalPages: 1,
                docs: [
                  {
                    id: 21,
                    revision: 2,
                    title: "Earlier synthetic",
                    status: "draft",
                    createdAt: "2026-10-23T12:00:00Z",
                  },
                ],
              }
            : { revision: 5 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(createElement(OwnerWorkflowClient));
    await screen.findByText("Synthetic catalog");
    fireEvent.click(screen.getByRole("tab", { name: "版本恢复" }));
    expect(screen.queryByLabelText("执行账号")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看历史" }));
    await screen.findByLabelText("历史版本");
    fireEvent.change(screen.getByLabelText("历史版本"), {
      target: { value: "21" },
    });
    fireEvent.click(screen.getByRole("button", { name: "恢复为新草稿" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url]) => url.endsWith("restore-draft")),
      ).toBe(true),
    );
    const call = fetch.mock.calls.find(([url]) =>
      url.endsWith("restore-draft"),
    );
    expect(
      JSON.parse((call as unknown as [string, RequestInit])[1].body as string),
    ).toEqual({ versionId: 21, expectedRevision: 4 });
  });
});
