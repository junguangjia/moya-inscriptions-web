export const fontFamily = {
  editorial:
    '"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif',
  interface:
    '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif',
} as const;

export const articleLineHeight = {
  compact: 1.5,
  normal: 1.9,
  relaxed: 2.2,
} as const;

export const typographyNames = [
  "display",
  "page-title",
  "section-title",
  "card-title",
  "list-title",
  "body",
  "body-small",
  "caption",
  "metadata",
  "label",
  "button",
  "navigation",
  "input",
] as const;

export type TypographyName = (typeof typographyNames)[number];

export type TypographyDefinition = {
  mobileSize: string;
  desktopSize: string;
  weight: number;
  lineHeight: number;
  letterSpacing: string;
};

export const typography = {
  display: {
    mobileSize: "36px",
    desktopSize: "52px",
    weight: 600,
    lineHeight: 1.15,
    letterSpacing: "-0.02em",
  },
  "page-title": {
    mobileSize: "28px",
    desktopSize: "36px",
    weight: 600,
    lineHeight: 1.25,
    letterSpacing: "-0.01em",
  },
  "section-title": {
    mobileSize: "22px",
    desktopSize: "26px",
    weight: 600,
    lineHeight: 1.3,
    letterSpacing: "0",
  },
  "card-title": {
    mobileSize: "16px",
    desktopSize: "18px",
    weight: 600,
    lineHeight: 1.45,
    letterSpacing: "0",
  },
  "list-title": {
    mobileSize: "16px",
    desktopSize: "17px",
    weight: 600,
    lineHeight: 1.45,
    letterSpacing: "0",
  },
  body: {
    mobileSize: "16px",
    desktopSize: "16px",
    weight: 400,
    lineHeight: 1.75,
    letterSpacing: "0",
  },
  "body-small": {
    mobileSize: "14px",
    desktopSize: "14px",
    weight: 400,
    lineHeight: 1.65,
    letterSpacing: "0",
  },
  caption: {
    mobileSize: "12px",
    desktopSize: "12px",
    weight: 400,
    lineHeight: 1.5,
    letterSpacing: "0",
  },
  metadata: {
    mobileSize: "12px",
    desktopSize: "13px",
    weight: 400,
    lineHeight: 1.5,
    letterSpacing: "0.01em",
  },
  label: {
    mobileSize: "13px",
    desktopSize: "13px",
    weight: 600,
    lineHeight: 1.35,
    letterSpacing: "0.04em",
  },
  button: {
    mobileSize: "15px",
    desktopSize: "15px",
    weight: 600,
    lineHeight: 1.3,
    letterSpacing: "0.01em",
  },
  navigation: {
    mobileSize: "13px",
    desktopSize: "14px",
    weight: 600,
    lineHeight: 1.3,
    letterSpacing: "0.03em",
  },
  input: {
    mobileSize: "16px",
    desktopSize: "16px",
    weight: 400,
    lineHeight: 1.5,
    letterSpacing: "0",
  },
} as const satisfies Record<TypographyName, TypographyDefinition>;
