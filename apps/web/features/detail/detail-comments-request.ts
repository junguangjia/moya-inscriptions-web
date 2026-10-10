/**
 * A one-shot request that the next Detail of one content opens on its
 * comments page, made by a feed post's comment entry right before it opens
 * Detail. The next Detail to mount clears it whatever it shows, and an
 * unclaimed request expires, so a refused open never redirects a later one.
 */
const REQUEST_LIFETIME_MS = 5_000;

let pending: { readonly id: string; readonly at: number } | null = null;

export const requestDetailComments = (id: string): void => {
  pending = { id, at: Date.now() };
};

/** Whether Detail `id` was asked to open on comments; pure, for render. */
export const detailCommentsRequested = (id: string): boolean =>
  pending !== null &&
  pending.id === id &&
  Date.now() - pending.at <= REQUEST_LIFETIME_MS;

export const clearDetailCommentsRequest = (): void => {
  pending = null;
};
