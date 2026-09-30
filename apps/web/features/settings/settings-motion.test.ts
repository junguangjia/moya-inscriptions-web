import { describe, expect, it } from "vitest";
import {
  SETTINGS_BROWSER_EDGE_PX,
  settingsSwipeIntent,
  shouldCommitSettingsBack,
} from "./settings-motion";
describe("settings Back intent", () => {
  it("reserves the native browser edge and distinguishes small, vertical and horizontal starts", () => {
    expect(SETTINGS_BROWSER_EDGE_PX).toBeGreaterThanOrEqual(24);
    expect(settingsSwipeIntent(4, 5)).toBe("pending");
    expect(settingsSwipeIntent(10, 30)).toBe("cancel");
    expect(settingsSwipeIntent(-30, 1)).toBe("cancel");
    expect(settingsSwipeIntent(20, 5)).toBe("back");
  });
  it("commits distance or intentional flicks and cancels short slow drags", () => {
    expect(shouldCommitSettingsBack(120, 430, 700)).toBe(true);
    expect(shouldCommitSettingsBack(40, 390, 50)).toBe(true);
    expect(shouldCommitSettingsBack(24, 390, 20)).toBe(false);
    expect(shouldCommitSettingsBack(50, 390, 500)).toBe(false);
  });
});
