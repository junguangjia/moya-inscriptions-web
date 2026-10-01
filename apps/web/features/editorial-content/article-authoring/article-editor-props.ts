import type {
  ArticleCandidateCommand,
  ArticleDraft,
  ArticlePreview,
  ArticlePublishResult,
  ArticleValidationResult,
} from "@moya/contracts";
import type { RefObject } from "react";
import type { ProductShellEditorOverlayControls } from "../../product-shell/product-shell";
import type { ArticleAutosavePort } from "./article-autosave";
import type { ArticleMediaBridge } from "./article-attachments";

export interface ArticleEditorClient extends ArticleAutosavePort {
  validate(
    id: ArticleDraft["id"],
    command: ArticleCandidateCommand,
    signal?: AbortSignal,
  ): Promise<ArticleValidationResult>;
  preview(
    id: ArticleDraft["id"],
    command: ArticleCandidateCommand,
    signal?: AbortSignal,
  ): Promise<ArticlePreview>;
  publish(
    id: ArticleDraft["id"],
    command: ArticleCandidateCommand,
    signal?: AbortSignal,
  ): Promise<ArticlePublishResult>;
}
export interface ArticleEditorProps {
  /** Stable for ordinary saves; changed only for an explicit account/draft/reload transition. */
  readonly sessionKey: string;
  /** Original loaded-session epoch, including the lazy editor mount interval. */
  readonly accountEpoch: number;
  readonly backButtonRef?: RefObject<HTMLButtonElement | null>;
  readonly registerLeaveGuard?: ProductShellEditorOverlayControls["registerLeaveGuard"];
  readonly initial: ArticleDraft;
  readonly client: ArticleEditorClient;
  readonly media: ArticleMediaBridge;
  readonly onBack: () => void;
  readonly onPublished: (id: ArticleDraft["id"]) => void;
  readonly onReloadDraft: (remote: ArticleDraft) => void;
}
