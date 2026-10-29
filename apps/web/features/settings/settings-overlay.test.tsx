import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SettingsOverlay } from "./settings-overlay";

const renderSettings = (platform: "phone" | "tablet" | "pc") =>
  renderToStaticMarkup(
    <SettingsOverlay
      backButtonRef={createRef<HTMLButtonElement>()}
      feedLayout="double"
      onClose={vi.fn()}
      onCycleFeedLayout={vi.fn()}
      onCycleTheme={vi.fn()}
      platform={platform}
      theme="system"
    />,
  );

describe("SettingsOverlay", () => {
  it.each(["phone", "tablet", "pc"] as const)(
    "shows the approved feed layout preference on %s",
    (platform) => {
      const markup = renderSettings(platform);
      expect(markup).toContain("data-feed-layout-toggle");
      expect(markup).toContain("正常模式示意图");
      expect(markup).toContain("切换布局：当前正常模式");
    },
  );

  it("shows the effective mode and theme controls on PC", () => {
    const markup = renderSettings("pc");
    expect(markup).toContain("data-feed-layout-toggle");
    expect(markup).toContain("切换主题：当前跟随系统");
    expect(markup).not.toContain("调试日志");
  });
});
