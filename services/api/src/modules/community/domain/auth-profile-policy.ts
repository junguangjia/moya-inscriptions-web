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

/** Paired editors store a combined name; omitted suffix retains legacy writes. */
export const normalizeStudioNameInput = (
  name: unknown,
  suffix: unknown,
): { studioName: string; studioNameSuffix: string } | null => {
  if (suffix === undefined) {
    const studioName = normalizeStudioName(name === undefined ? "" : name);
    return studioName === null ? null : { studioName, studioNameSuffix: "" };
  }
  if (typeof name !== "string" || typeof suffix !== "string") return null;
  const studioName = name.trim(),
    studioNameSuffix = suffix.trim();
  if (hasInvalidScalar(studioName) || hasInvalidScalar(studioNameSuffix))
    return null;
  if (studioName === "" && studioNameSuffix === "")
    return { studioName, studioNameSuffix };
  if (
    ![1, 2].includes([...studioNameSuffix].length) ||
    !studioName.endsWith(studioNameSuffix)
  )
    return null;
  const base = studioName.slice(0, -studioNameSuffix.length);
  return base === base.trim() && [...base].length >= 1 && [...base].length <= 5
    ? { studioName, studioNameSuffix }
    : null;
};
