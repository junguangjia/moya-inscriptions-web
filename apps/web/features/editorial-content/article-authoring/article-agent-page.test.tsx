import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../authors/author-context", () => ({
  AuthorProvider: ({ children }: { readonly children: ReactNode }) => children,
  useAuthors: () => ({ viewer: null, checking: true, signInHref: "/login" }),
}));
vi.mock("../../../lib/public-api/author-community-client", () => ({
  authorClient: { account: () => null, accountEpoch: () => 0 },
}));
vi.mock("../../../lib/public-api/work-publishing-client", () => ({
  publishingClient: {},
}));
vi.mock("../../../lib/public-api/catalog-detail-client", () => ({
  fetchSameOriginCatalogDetail: vi.fn(),
}));
vi.mock("../../product-application/community-comment-surface", () => ({
  developmentSignInPath: "/dev/community",
}));
vi.mock("./article-media-resolver", () => ({
  createArticleMediaResolver: vi.fn(),
}));
vi.mock("./article-delegation", () => ({
  ArticleAgentApproval: () => null,
  ArticleAgentConsent: () => null,
}));
vi.mock("./article-rich-body", () => ({ ArticleRichBody: () => null }));
vi.mock("./article-managed-media", () => ({
  ArticleCatalogReference: () => null,
  ArticleReferencedMedia: () => null,
}));

import { ArticleAgentPage } from "./article-agent-page";

describe("article agent page return", () => {
  it("returns to the Article drafts through the shared icon-only back", () => {
    const markup = renderToStaticMarkup(<ArticleAgentPage />);
    // The link leads the page and holds only the shared icon, no text.
    expect(markup).toMatch(
      /^<main class="phase4-page"><a aria-label="返回专题文章与草稿"[^>]*href="\/#article-editor"><span[^>]*data-icon="back"[^>]*><\/span><\/a>/,
    );
    expect(markup).not.toContain(">返回专题文章与草稿<");
    expect(markup).toContain("授权入口不可用。");
  });
});
