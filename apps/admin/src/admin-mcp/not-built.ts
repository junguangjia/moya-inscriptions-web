/**
 * What a table says where it holds nothing yet, so "not built yet" and "forgotten" never
 * read the same (docs/development/admin-mcp-extending.md). A table over a key type is a
 * whole Record: a new route or record type fails typecheck until its row says what it
 * has, which slice brings it, or why it has none.
 */

/** The slices of Issue #355 still to come. Each removes its own rows when it lands. */
export type AdminMcpSlice = "S8" | "S9" | "S10" | "S11" | "S12" | "S13" | "S14";

export interface NotBuilt {
  readonly notBuilt: AdminMcpSlice;
}

export interface NoEntry {
  readonly none: string;
}

export type Unbuilt = NotBuilt | NoEntry;

export const notBuilt = (slice: AdminMcpSlice): NotBuilt => ({
  notBuilt: slice,
});

/** Fixed English: why this key has no entry, and never will under the current design. */
export const none = (reason: string): NoEntry => ({ none: reason });

/** The row's entry, or undefined where the row says it has none. */
export const built = <Entry extends object>(
  row: Entry | Unbuilt,
): Entry | undefined =>
  "notBuilt" in row || "none" in row ? undefined : (row as Entry);
