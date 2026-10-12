"use client";

import type { RefObject } from "react";

import { Icon } from "@moya/ui";

import styles from "./settings-overlay.module.css";
import { FeedLayoutPreview } from "./feed-layout-preview";
import { feedLayoutLabels } from "../product-shell/preferences";

import type {
  FeedLayoutPreference,
  ThemePreference,
} from "../product-shell/preferences";
import type { PresentationPlatform } from "../shell/device-platform";
import type { IconName } from "@moya/ui";

const themeLabels = {
  dark: "深色模式",
  light: "浅色模式",
  system: "跟随系统",
} as const satisfies Record<ThemePreference, string>;

const themeIcons = {
  dark: "theme-dark",
  light: "theme-light",
  system: "theme-system",
} as const satisfies Record<ThemePreference, IconName>;

const layoutIcons = {
  double: "layout-double",
  single: "layout-single",
} as const satisfies Record<FeedLayoutPreference, IconName>;

export interface SettingsOverlayProps {
  readonly backButtonRef: RefObject<HTMLButtonElement | null>;
  readonly feedLayout: FeedLayoutPreference;
  readonly onClose: () => void;
  readonly onCycleFeedLayout: () => void;
  readonly onCycleTheme: () => void;
  readonly platform: PresentationPlatform;
  readonly theme: ThemePreference;
}

export const SettingsOverlay = ({
  backButtonRef,
  feedLayout,
  onClose,
  onCycleFeedLayout,
  onCycleTheme,
  platform,
  theme,
}: SettingsOverlayProps) => (
  <section
    aria-label="设置"
    aria-modal="true"
    className={`${styles.overlay} yoyi-paper yoyi-paper--visible`}
    data-product-settings=""
    role="dialog"
  >
    <header className={styles.header}>
      <button
        ref={backButtonRef}
        type="button"
        aria-label="返回"
        className={`${styles.iconButton} yoyi-icon-button yoyi-icon-button--quiet yoyi-icon-button--md`}
        data-settings-back=""
        onClick={onClose}
      >
        <Icon name="back" />
      </button>
      <h1>设置</h1>
      <span aria-hidden="true" className={styles.headerSpacer} />
    </header>

    <div className={styles.content}>
      <SettingsDisplayControls
        feedLayout={feedLayout}
        onCycleFeedLayout={onCycleFeedLayout}
        onCycleTheme={onCycleTheme}
        platform={platform}
        theme={theme}
      />
    </div>
  </section>
);

/** The same display controls serve the product settings and My settings. */
export const SettingsDisplayControls = ({
  feedLayout,
  onCycleFeedLayout,
  onCycleTheme,
  platform,
  theme,
}: Pick<
  SettingsOverlayProps,
  "feedLayout" | "onCycleFeedLayout" | "onCycleTheme" | "platform" | "theme"
>) => (
  <fieldset className={styles.group}>
    <legend>显示</legend>
    <div className={styles.controls}>
      <button
        type="button"
        aria-label={`切换主题：当前${themeLabels[theme]}`}
        className={`${styles.settingButton} yoyi-icon-button yoyi-icon-button--quiet yoyi-icon-button--md`}
        data-theme-mode={theme}
        data-theme-toggle=""
        onClick={onCycleTheme}
        title={themeLabels[theme]}
      >
        <Icon name={themeIcons[theme]} />
        <span>{themeLabels[theme]}</span>
      </button>

      {platform === "pc" ? null : (
        <button
          type="button"
          aria-label={`切换布局：当前${feedLayoutLabels[feedLayout]}`}
          className={`${styles.settingButton} yoyi-icon-button yoyi-icon-button--quiet yoyi-icon-button--md`}
          data-feed-layout-mode={feedLayout}
          data-feed-layout-toggle=""
          onClick={onCycleFeedLayout}
          title={feedLayoutLabels[feedLayout]}
        >
          <Icon name={layoutIcons[feedLayout]} />
          <span>{feedLayoutLabels[feedLayout]}</span>
        </button>
      )}
    </div>
    {platform !== "pc" && <FeedLayoutPreview value={feedLayout} />}
  </fieldset>
);
