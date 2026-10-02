import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock(
  "../../features/editorial-content/article-authoring/article-agent-page",
  () => ({
    ArticleAgentPage: () => null,
  }),
);

import ApprovalPage from "./approval/page";
import ConsentPage from "./consent/[uid]/page";

const query = {
  connection: `article-connection-${"a".repeat(32)}`,
  article: `article-${"b".repeat(32)}`,
  version: "7",
  fingerprint: "c".repeat(64),
};
afterEach(() => vi.unstubAllEnvs());

describe.each(["development", "production"])(
  "Article human entry pages in %s",
  (environment) => {
    it("passes the valid consent interaction to the existing human entry", async () => {
      vi.stubEnv("NODE_ENV", environment);
      const page = await ConsentPage({
        params: Promise.resolve({ uid: "synthetic-interaction" }),
      });
      expect(page.props).toEqual({ interactionUid: "synthetic-interaction" });
    });
    it("preserves the exact approval candidate and does not accept authority from query fields", async () => {
      vi.stubEnv("NODE_ENV", environment);
      const page = await ApprovalPage({
        searchParams: Promise.resolve({
          ...query,
          scopes: "unrequested:scope",
          owner: "untrusted-owner",
          issuer: "https://foreign.invalid",
        }),
      });
      expect(page.props).toEqual({
        candidate: {
          connectionId: query.connection,
          articleId: query.article,
          expectedVersion: 7,
          fingerprint: query.fingerprint,
        },
      });
    });
    it("retains malformed interaction and candidate rejection", async () => {
      vi.stubEnv("NODE_ENV", environment);
      await expect(
        ConsentPage({ params: Promise.resolve({ uid: "../invalid" }) }),
      ).rejects.toThrow("NEXT_NOT_FOUND");
      for (const version of ["0", "1e3", ["1", "2"]])
        await expect(
          ApprovalPage({
            searchParams: Promise.resolve({ ...query, version }),
          }),
        ).rejects.toThrow("NEXT_NOT_FOUND");
    });
  },
);
