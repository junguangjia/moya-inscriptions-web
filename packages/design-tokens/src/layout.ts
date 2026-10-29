export const spacing = {
  0: "0",
  1: "2px",
  2: "4px",
  3: "8px",
  4: "12px",
  5: "16px",
  6: "20px",
  7: "24px",
  8: "32px",
  9: "40px",
  10: "48px",
  11: "64px",
  12: "80px",
} as const;

export const radius = {
  none: "0",
  xs: "2px",
  sm: "4px",
  md: "8px",
  lg: "12px",
  full: "999px",
} as const;

export const breakpoint = {
  narrow: "360px",
  mobile: "390px",
  tablet: "768px",
  navigation: "896px",
  desktop: "1024px",
  wide: "1440px",
} as const;

export const container = {
  content: "1200px",
  reading: "760px",
} as const;

/** Desktop presentation geometry, shared by measurement and CSS tokens. */
export const desktopLayout = {
  navigationWidth: 72,
  categoryWidth: 56,
  workspaceMax: 1440,
  readerMax: 1920,
  formMax: 720,
  messageMax: 1280,
  feed: {
    rowHeight: 240,
    rowMin: 200,
    rowMax: 300,
    gap: 20,
    rowGap: 24,
    labelWidth: 72,
    textWidth: 232,
    minimumRatio: 0.4,
    maximumRatio: 2.8,
  },
} as const;
