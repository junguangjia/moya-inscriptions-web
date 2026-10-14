/** A strong validator (RFC 9110 §8.8.3) for bytes named by their SHA-256. */
export const strongEntityTag = (sha256: string): string => `"${sha256}"`;

/**
 * If-None-Match uses weak comparison (RFC 9110 §13.1.2): `W/"x"` and `"x"`
 * match, `*` matches any current representation, and a list matches when one
 * of its members does. Repeated header lines count as one list.
 */
export const ifNoneMatchIncludes = (
  header: string | readonly string[] | undefined,
  tag: string,
): boolean =>
  header !== undefined &&
  (typeof header === "string" ? header : header.join(","))
    .split(",")
    .map((part) => part.trim())
    .some((part) => part === "*" || part.replace(/^W\//u, "") === tag);
