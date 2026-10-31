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
    rowMax: 320,
    rowHardMax: 360,
    featureMax: 720,
    gap: 12,
    rowGap: 12,
    labelWidth: 72,
    cardArea: 100000,
    compactCardArea: 52000,
    cardAreaReferenceWidth: 1000,
    cardAreaTolerance: 0.2,
    cardMinHeight: 140,
    cardCompactMinHeight: 120,
    cardCompactWidth: 896,
    cardMaxHeight: 420,
    cardMaxWidth: 580,
    mediaTargetWidth: 270,
    textWidth: 232,
    minimumRatio: 0.4,
    maximumRatio: 2.8,
  },
} as const;
