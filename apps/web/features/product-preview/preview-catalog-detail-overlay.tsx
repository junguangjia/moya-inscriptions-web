"use client";

import { useEffect, useRef, useState } from "react";

import { CatalogDetailExperience } from "../detail/catalog-detail-experience";
import { useProductShell } from "../product-shell/product-shell";
import { useOptionalAuthors } from "../authors/author-context";
import { useAuthReturn } from "../auth/auth-return";

import type { ReactNode, RefObject } from "react";
import type { ContentIdentity } from "@moya/contracts";
import type { CatalogDetailPresentationLoader } from "../detail/load-catalog-detail";
import type {
  CatalogDetailPresentation,
  CatalogDetailPresentationState,
} from "../detail/catalog-detail-presentation";

export interface PreviewCatalogDetailOverlayProps {
  readonly backButtonRef: RefObject<HTMLButtonElement | null>;
  readonly catalogId: string;
  readonly target?: ContentIdentity;
  readonly commentSection?: ReactNode;
  readonly renderActions?: (
    detail: CatalogDetailPresentation,
    refresh: () => void,
  ) => ReactNode;
  readonly initialScrollTop: number;
  readonly loader: CatalogDetailPresentationLoader;
  readonly onClose: () => void;
  readonly onScrollTopChange: (top: number) => void;
}

export const PreviewCatalogDetailOverlay = ({
  backButtonRef,
  catalogId,
  target,
  commentSection,
  renderActions,
  initialScrollTop,
  loader,
  onClose,
  onScrollTopChange,
}: PreviewCatalogDetailOverlayProps) => {
  const author = useOptionalAuthors();
  const authReturn = useAuthReturn();
  const identityReady =
    author === null || (!author.checking && !author.sessionError);
  const targetType = target?.type ?? "catalog";
  const targetId = target?.id ?? catalogId;
  const {
    activeViewerMediaId,
    changeViewerMedia,
    closeViewer,
    openViewer,
    orientation,
    platform,
    recoverUnavailableAuthContent,
  } = useProductShell();
  const generationRef = useRef(0);
  const missingTargetRef = useRef<ContentIdentity | null>(null);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<CatalogDetailPresentationState>({
    state: "loading",
  });

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++generationRef.current;
    missingTargetRef.current = null;
    setState({ state: "loading" });
    void loader(catalogId, controller.signal)
      .then((nextState) => {
        if (
          !controller.signal.aborted &&
          generationRef.current === generation
        ) {
          missingTargetRef.current =
            nextState.state === "not-found"
              ? { type: targetType, id: targetId }
              : null;
          setState(nextState);
        }
      })
      .catch(() => {
        if (
          !controller.signal.aborted &&
          generationRef.current === generation
        ) {
          setState({ state: "unexpected-error" });
        }
      });
    return () => controller.abort();
  }, [catalogId, loader, revision, targetType, targetId]);

  useEffect(() => {
    // A confirmed /me can re-key source feeds and this Detail. Let that commit
    // read its public snapshot before retiring the journey for a missing item.
    if (!identityReady || state.state !== "not-found") return;
    const missing = missingTargetRef.current;
    if (missing !== null) recoverUnavailableAuthContent(missing);
  }, [
    identityReady,
    state.state,
    recoverUnavailableAuthContent,
    targetType,
    targetId,
  ]);

  // A missing Viewer normally closes itself with Back. During this source
  // recovery the shell replaces both Viewer and Detail together, after /me;
  // keep the child in its loading view until that recovery can commit.
  const presentedState: CatalogDetailPresentationState =
    state.state === "not-found" && authReturn?.isRestoring()
      ? { state: "loading" }
      : state;

  return (
    <CatalogDetailExperience
      activeViewerMediaId={activeViewerMediaId}
      backButtonRef={backButtonRef}
      catalogId={catalogId}
      commentSection={commentSection}
      detailActions={
        state.state === "loaded"
          ? renderActions?.(state.detail, () => setRevision((v) => v + 1))
          : undefined
      }
      initialScrollTop={initialScrollTop}
      onBack={onClose}
      onCloseViewer={closeViewer}
      onOpenViewer={openViewer}
      onScrollTopChange={onScrollTopChange}
      onViewerMediaChange={changeViewerMedia}
      orientation={orientation}
      platform={platform}
      state={presentedState}
    />
  );
};
