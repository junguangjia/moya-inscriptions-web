import { describe, expect, it } from "vitest";
import { createQaCommentFixture } from "./comment-scenarios";

describe("inline image QA coverage", () => {
  it("keeps nine explicit QA entries covering start, middle, end and image-only bodies", () => {
    const roots = createQaCommentFixture(
      "comment-inline-images",
      "qa-inline-preview",
    );
    const rows = roots.flatMap((r) => [r, ...r.replies]);
    expect(roots).toHaveLength(6);
    expect(rows).toHaveLength(9);
    expect(new Set(rows.map((r) => r.id)).size).toBe(9);
    expect(rows.every((r) => r.id.startsWith("qa-"))).toBe(true);
    expect(rows.some((r) => !r.text && r.images?.length)).toBe(true);
    expect(rows.some((r) => r.images?.some((i) => i.offset === 0))).toBe(true);
    expect(
      rows.some((r) =>
        r.images?.some((i) => i.offset > 0 && i.offset < r.text.length),
      ),
    ).toBe(true);
    expect(
      rows.some((r) =>
        r.images?.some((i) => i.offset === r.text.length && i.offset > 0),
      ),
    ).toBe(true);
    for (const row of rows) {
      for (const image of row.images ?? []) {
        expect(image.offset).toBeGreaterThanOrEqual(0);
        expect(image.offset).toBeLessThanOrEqual(row.text.length);
        expect(image.src).toMatch(/^\/docs\/design-system\/assets\/demo\//u);
      }
    }
  });
});
