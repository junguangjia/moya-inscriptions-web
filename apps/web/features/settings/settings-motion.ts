/** Settings-local navigation intent. Browser-edge gestures remain native. */
export const SETTINGS_BROWSER_EDGE_PX = 24;
export const SETTINGS_INTENT_PX = 8;
export const settingsSwipeIntent = (
  dx: number,
  dy: number,
): "pending" | "back" | "cancel" => {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SETTINGS_INTENT_PX)
    return "pending";
  return dx > 0 && dx > Math.abs(dy) * 1.25 ? "back" : "cancel";
};
export const shouldCommitSettingsBack = (
  distance: number,
  width: number,
  elapsed: number,
): boolean =>
  distance >= Math.min(120, width * 0.28) ||
  (distance >= 32 && distance / Math.max(1, elapsed) >= 0.5);
