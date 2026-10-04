"use client";
import { useEffect, useState } from "react";
import type { ArticleApprovalCandidate } from "@moya/contracts";
import { Icon } from "@moya/ui";
import { authorClient } from "../../../lib/public-api/author-community-client";
import { publishingClient } from "../../../lib/public-api/work-publishing-client";
import { fetchSameOriginCatalogDetail } from "../../../lib/public-api/catalog-detail-client";
import { createArticleMediaResolver } from "./article-media-resolver";
import type { ArticleMediaResolver } from "./article-media-resolver";
import { AuthorProvider, useAuthors } from "../../authors/author-context";
import { developmentSignInPath } from "../../product-application/community-comment-surface";
import {
  ArticleAgentApproval,
  ArticleAgentConsent,
} from "./article-delegation";
import { ArticleRichBody } from "./article-rich-body";
import {
  ArticleCatalogReference,
  ArticleReferencedMedia,
} from "./article-managed-media";

export const ArticleAgentPage = ({
  candidate,
  interactionUid,
}: {
  readonly candidate?: ArticleApprovalCandidate;
  readonly interactionUid?: string;
}) => (
  <AuthorProvider signInHref={developmentSignInPath}>
    <HumanEntry
      {...(candidate === undefined ? {} : { candidate })}
      {...(interactionUid === undefined ? {} : { interactionUid })}
    />
  </AuthorProvider>
);
const HumanEntry = ({
  candidate,
  interactionUid,
}: {
  readonly candidate?: ArticleApprovalCandidate;
  readonly interactionUid?: string;
}) => {
  const author = useAuthors();
  const ownerId = author.viewer?.id ?? null;
  const epoch = authorClient.accountEpoch();
  const approval = candidate !== undefined;
  const [resource, setResource] = useState<{
    ownerId: string;
    epoch: number;
    resolver: ArticleMediaResolver;
  } | null>(null);
  const resolver =
    resource?.ownerId === ownerId && resource.epoch === epoch
      ? resource.resolver
      : null;
  useEffect(() => {
    if (ownerId === null || !approval || authorClient.account() !== ownerId)
      return;
    const value = createArticleMediaResolver({
      ownerId,
      epoch,
      account: authorClient.account,
      accountEpoch: authorClient.accountEpoch,
      readyItems: () => new Map(),
      readManaged: (id, signal) => publishingClient.item(id, signal),
      readCatalog: async (id, signal) => {
        const result = await fetchSameOriginCatalogDetail(id, signal);
        return result.state === "success" ? result.detail : null;
      },
    });
    setResource({ ownerId, epoch, resolver: value });
    return () => value.dispose();
  }, [ownerId, epoch, approval]);
  return (
    <main className="phase4-page">
      <a
        aria-label="返回专题文章与草稿"
        className="yoyi-icon-button yoyi-icon-button--quiet yoyi-icon-button--md"
        href="/#article-editor"
      >
        <Icon name="back" />
      </a>
      {author.viewer === null && !author.checking ? (
        <p>
          <a href={author.signInHref}>登录当前作者账户</a>
        </p>
      ) : null}
      {interactionUid === undefined ? (
        candidate === undefined ? (
          <p role="status">授权入口不可用。</p>
        ) : (
          <ArticleAgentApproval
            candidate={candidate}
            renderPreview={(preview) =>
              resolver === null ? (
                <p role="status">正在读取当前账号素材…</p>
              ) : (
                <article aria-label="候选文章预览">
                  <h2>{preview.draft.title}</h2>
                  {preview.draft.coverRefId === null ? null : (
                    <figure>
                      <ArticleReferencedMedia
                        resolver={resolver}
                        reference={
                          preview.draft.document.references[
                            preview.draft.coverRefId
                          ]!
                        }
                        alt="候选封面"
                        active={!author.checking}
                      />
                    </figure>
                  )}
                  <ArticleRichBody
                    document={preview.draft.document}
                    renderMedia={(reference, alt) => (
                      <ArticleReferencedMedia
                        resolver={resolver}
                        reference={reference}
                        alt={alt}
                        active={!author.checking}
                      />
                    )}
                    renderCatalog={(id) => (
                      <ArticleCatalogReference
                        resolver={resolver}
                        id={id}
                        onOpen={(catalogId) =>
                          window.open(
                            `/?catalogId=${encodeURIComponent(catalogId)}#detail`,
                            "_blank",
                            "noopener,noreferrer",
                          )
                        }
                      />
                    )}
                  />
                </article>
              )
            }
          />
        )
      ) : (
        <ArticleAgentConsent interactionUid={interactionUid} />
      )}
    </main>
  );
};
