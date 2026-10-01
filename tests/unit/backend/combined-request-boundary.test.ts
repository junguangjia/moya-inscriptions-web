/**
 * parallel-community-integration-qa: C's repair (content-community-completion-v1,
 * finding C2) contains every route handler the Backend router starts without
 * awaiting it, so a rejected handler fails only its own request instead of
 * ending the process (behavior proven by
 * tests/integration/postgres/operator-error-boundary.test.ts). The combined
 * router also starts A's authentication and N's notification handlers; this
 * keeps every dispatch, including those, inside that boundary.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const router = readFileSync(
  new URL(
    "../../../services/backend-runtime/src/http/router.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("combined A/N/C request boundary", () => {
  it("starts no route handler outside containRequest", () => {
    expect(router.match(/\bvoid\s+handle[A-Z]\w*\(/gu) ?? []).toEqual([]);
  });

  it.each([
    "handleCommunityAuth",
    "handleNotificationRequest",
    "handleAuthorRequest",
    "handleOperatorRequest",
  ])("contains %s", (handler) => {
    expect(router).toMatch(
      new RegExp(`containRequest\\(\\s*response,\\s*${handler}\\(`, "u"),
    );
  });
});
