import { afterEach, describe, expect, it, vi } from "vitest";
import { analyticsWorkspace } from "admin/analytics-config";

afterEach(() => vi.unstubAllEnvs());

const configure = () => {
  vi.stubEnv("UMAMI_WEBSITE_ID", "10000000-0000-4000-8000-000000000001");
  vi.stubEnv("UMAMI_BOARD_ID", "10000000-0000-4000-8000-000000000002");
  vi.stubEnv("UMAMI_ORIGIN", "http://127.0.0.1:3010");
  vi.stubEnv("UMAMI_VIEWER_USERNAME", "synthetic-viewer");
  vi.stubEnv("UMAMI_VIEWER_PASSWORD", "REPLACE_ME_SYNTHETIC_VIEWER");
};

describe("Owner analytics landing", () => {
  it("opens the configured province/city Board without exposing credentials", () => {
    configure();
    expect(analyticsWorkspace()).toEqual({
      configured: true,
      path: "/admin/analytics-workspace/boards/10000000-0000-4000-8000-000000000002",
    });
  });

  it.each([undefined, "", "../websites/other", "not-a-uuid"])(
    "does not fall back to the world-map overview for invalid Board %s",
    (boardId) => {
      configure();
      vi.stubEnv("UMAMI_BOARD_ID", boardId);
      expect(analyticsWorkspace()).toEqual({ configured: false, path: null });
    },
  );
});
