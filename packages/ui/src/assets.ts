export const iconNames = [
  "home",
  "discussion",
  "news",
  "academic-cap",
  "message",
  "user",
  "edit",
  "inscriptions",
  "calligraphy",
  "search",
  "back",
  "menu",
  "close",
  "filter",
  "category",
  "location",
  "nearby",
  "timeline",
  "image",
  "loading",
  "error",
  "empty",
  "previous",
  "next",
  "theme",
  "theme-light",
  "theme-dark",
  "theme-system",
  "layout-single",
  "layout-double",
  "settings",
] as const;

export type IconName = (typeof iconNames)[number];

export const fixedLabelNames = [
  "nav-home",
  "nav-inscriptions",
  "nav-calligraphy",
] as const;

export type FixedLabelName = (typeof fixedLabelNames)[number];

const assetUrl = (relativePath: string): string =>
  new URL(`../src/assets/${relativePath}`, import.meta.url).href;

export const brandAssetUrls = {
  logo: assetUrl("brand/yoyi-logo.svg"),
} as const;

export const textureAssetUrls = {
  paperSubtle: assetUrl("textures/paper-subtle.svg"),
  paperVisible: assetUrl("textures/paper-visible.svg"),
  paperDarkSubtle: assetUrl("textures/paper-dark-subtle.svg"),
  paperDarkVisible: assetUrl("textures/paper-dark-visible.svg"),
} as const;

export const iconAssetUrls = Object.fromEntries(
  iconNames.map((name) => [name, assetUrl(`icons/${name}.svg`)]),
) as Record<IconName, string>;

export const fixedLabelAssetUrls = Object.fromEntries(
  fixedLabelNames.map((name) => [name, assetUrl(`labels/${name}.png`)]),
) as Record<FixedLabelName, string>;
