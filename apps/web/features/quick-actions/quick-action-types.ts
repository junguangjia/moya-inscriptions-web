export const quickActionNames = ["like", "favorite", "share"] as const;
export type QuickActionName = (typeof quickActionNames)[number];

export interface QuickActionContent {
  readonly kind: "catalog" | "work" | "nearby" | "topic";
  readonly id: string;
  readonly title: string;
}

export const quickActionContentKey = (content: QuickActionContent): string =>
  JSON.stringify([content.kind, content.id]);

// Presentation-only capabilities. No business service or content library.
export interface ContentQuickActionEnvironment {
  readonly likedIds: readonly string[];
  readonly favoriteIds: readonly string[];
  readonly onAction: (
    action: QuickActionName,
    content: QuickActionContent,
  ) => void | Promise<boolean>;
  /** Aggregates for the visible single-column action row; null while unknown. */
  readonly likeCount?: number | null;
  readonly favoriteCount?: number | null;
  readonly commentCount?: number | null;
  /** False while the viewer's state is unconfirmed or a toggle is in flight. */
  readonly ready?: boolean;
}
