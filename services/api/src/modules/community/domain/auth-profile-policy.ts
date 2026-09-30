/** Domain invariants; transport schemas are checked independently at the boundary. */
const hasInvalidScalar = (value: string): boolean =>
  value.includes("\u0000") || /[\uD800-\uDFFF]/u.test(value);

/** Count Unicode code points; never trim or normalize credential bytes. */
export const isValidAuthPassword = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const length = [...value].length;
  return (
    length >= 6 &&
    length <= 20 &&
    /[A-Z]/u.test(value) &&
    /[0-9]/u.test(value) &&
    !hasInvalidScalar(value)
  );
};

/** Omitted values default at the caller; explicit empty text clears the studio. */
export const normalizeStudioName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return [...normalized].length <= 6 && !hasInvalidScalar(normalized)
    ? normalized
    : null;
};
