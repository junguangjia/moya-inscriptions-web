import { afterEach, describe, expect, it, vi } from "vitest";
import { analyticsWorkspace } from "admin/analytics-config";
import {
  resolveAnalyticsBoardPath,
  resolveAnalyticsWorkspacePath,
} from "admin/analytics-upstream";

afterEach(() => vi.unstubAllEnvs());
const site = "10000000-0000-4000-8000-000000000001";
const team = "10000000-0000-4000-8000-000000000003";
const configure = () => {
  vi.stubEnv("UMAMI_WEBSITE_ID", site);
  vi.stubEnv("UMAMI_ORIGIN", "http://127.0.0.1:3010");
  vi.stubEnv("UMAMI_VIEWER_USERNAME", "REPLACE_ME_SYNTHETIC_VIEWER");
  vi.stubEnv("UMAMI_VIEWER_PASSWORD", "REPLACE_ME_SYNTHETIC_PASSWORD");
};
describe("Owner complete analytics landing", () => {
  it("retains the configured original Board in its team without another login", async () => {
    configure();
    const board = "10000000-0000-4000-8000-000000000002";
    vi.stubEnv("UMAMI_BOARD_ID", board);
    const request = vi
      .fn()
      .mockResolvedValue(Response.json({ id: board, teamId: team }));
    expect(await resolveAnalyticsBoardPath({ request })).toBe(
      `/admin/analytics-workspace/teams/${team}/boards/${board}`,
    );
    expect(request.mock.calls[0]?.[0]).toBe(
      `/admin/analytics-workspace/api/boards/${board}`,
    );
    vi.stubEnv("UMAMI_BOARD_ID", "");
    request.mockClear();
    expect(await resolveAnalyticsBoardPath({ request })).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
  it("targets the complete website analysis without requiring a summary Board", () => {
    configure();
    vi.stubEnv("UMAMI_BOARD_ID", undefined);
    expect(analyticsWorkspace()).toEqual({
      configured: true,
      path: `/admin/analytics-workspace/websites/${site}`,
    });
  });
  it.each([undefined, "", "../websites/other", "not-a-uuid"])(
    "refuses an invalid configured website %s",
    (value) => {
      configure();
      vi.stubEnv("UMAMI_WEBSITE_ID", value);
      expect(analyticsWorkspace()).toEqual({ configured: false, path: null });
    },
  );
  it("selects the website's team scope automatically and reads no account lists", async () => {
    configure();
    const request = vi.fn().mockResolvedValue(
      Response.json({
        id: site,
        teamId: team,
        shareId: "REPLACE_ME_UNUSED_SHARE",
      }),
    );
    const target = await resolveAnalyticsWorkspacePath({ request });
    expect(target).toBe(
      `/admin/analytics-workspace/teams/${team}/websites/${site}`,
    );
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe(
      `/admin/analytics-workspace/api/websites/${site}`,
    );
    expect(target).not.toContain("REPLACE_ME");
  });
  it("keeps a personal website usable but refuses a response for another source", async () => {
    configure();
    expect(
      await resolveAnalyticsWorkspacePath({
        request: vi
          .fn()
          .mockResolvedValue(Response.json({ id: site, teamId: null })),
      }),
    ).toBe(`/admin/analytics-workspace/websites/${site}`);
    await expect(
      resolveAnalyticsWorkspacePath({
        request: vi
          .fn()
          .mockResolvedValue(Response.json({ id: team, teamId: team })),
      }),
    ).rejects.toThrow("ANALYTICS_UNAVAILABLE");
  });
});
