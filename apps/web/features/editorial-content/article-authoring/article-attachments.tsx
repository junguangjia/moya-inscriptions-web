"use client";

import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type {
  ArticleBlock,
  ArticleDocument,
  ArticleDraft,
  ArticleMediaReference,
  CatalogId,
} from "@moya/contracts";

/** UI seam for the existing managed-media picker/viewer; this is not a wire DTO. */
export interface ArticleMediaBridge {
  choose(options: {
    readonly multiple: boolean;
    readonly signal: AbortSignal;
  }): Promise<readonly ArticleMediaReference[]>;
  chooseCatalog(signal: AbortSignal): Promise<CatalogId | null>;
  render(
    reference: ArticleMediaReference,
    options: {
      readonly alt: string;
      readonly active?: boolean;
      readonly onUnavailable?: () => void;
    },
  ): ReactNode;
  renderCatalog(id: CatalogId): ReactNode;
}

export interface ArticleAttachmentContextValue {
  readonly attachments: Pick<ArticleDocument, "references" | "galleries">;
  readonly media: ArticleMediaBridge;
  readonly disabled: boolean;
  readonly moveGalleryImage: (
    blockId: string,
    groupId: string,
    index: number,
    offset: -1 | 1,
  ) => void;
}
export const ArticleAttachmentContext =
  createContext<ArticleAttachmentContextValue | null>(null);
export const useArticleAttachments = (): ArticleAttachmentContextValue => {
  const context = useContext(ArticleAttachmentContext);
  if (context === null) throw new Error("article_attachment_context_missing");
  return context;
};

export const referenceEntry = (
  document: Pick<ArticleDocument, "references">,
  id: string,
) =>
  Object.hasOwn(document.references, id) ? document.references[id] : undefined;
export const galleryEntry = (
  document: Pick<ArticleDocument, "galleries">,
  id: string,
) =>
  Object.hasOwn(document.galleries, id) ? document.galleries[id] : undefined;

/** IDs stay stable and deleting a block never deletes an asset or its map entry. */
export const attachArticleReferences = (
  attachments: Pick<ArticleDocument, "references" | "galleries">,
  references: readonly ArticleMediaReference[],
  nextId: () => string,
) => {
  const next = {
    references: { ...attachments.references },
    galleries: { ...attachments.galleries },
  };
  const referenceIds = references.map((reference) => {
    const key = JSON.stringify(reference);
    const existing = Object.entries(next.references).find(
      ([, candidate]) => JSON.stringify(candidate) === key,
    );
    if (existing !== undefined) return existing[0];
    const id = nextId();
    next.references[id] = reference;
    return id;
  });
  return { attachments: next, referenceIds };
};

/** A new session has no Undo history. Retain only reachable maps at that boundary. */
export const articleSessionAttachments = (
  draft: Pick<ArticleDraft, "document" | "coverRefId">,
): Pick<ArticleDocument, "references" | "galleries"> => {
  const referenceIds = new Set<string>();
  const groupIds = new Set<string>();
  if (draft.coverRefId !== null) referenceIds.add(draft.coverRefId);
  const visit = (blocks: readonly ArticleBlock[]) => {
    for (const block of blocks) {
      if (block.type === "managedImage") referenceIds.add(block.props.refId);
      if (block.type === "imageGallery") {
        groupIds.add(block.props.groupId);
        const gallery = galleryEntry(draft.document, block.props.groupId);
        if (gallery !== undefined)
          for (const id of gallery.referenceIds) referenceIds.add(id);
      }
      visit(block.children);
    }
  };
  visit(draft.document.blocks);
  return {
    references: Object.fromEntries(
      Object.entries(draft.document.references).filter(([id]) =>
        referenceIds.has(id),
      ),
    ),
    galleries: Object.fromEntries(
      Object.entries(draft.document.galleries).filter(([id]) =>
        groupIds.has(id),
      ),
    ),
  };
};
