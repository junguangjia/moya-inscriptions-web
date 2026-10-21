"use client";

import { useEffect, useRef, useState } from "react";

import { CatalogDetailExperience } from "../detail/catalog-detail-experience";
import { useProductShell } from "../product-shell/product-shell";
import { useOptionalAuthors } from "../authors/author-context";
import { useAuthReturn } from "../auth/auth-return";
import { useContentAnalytics } from "../analytics/product-analytics";

import type { ReactNode, RefObject } from "react";
import type { ContentIdentity } from "@moya/contracts";
import type {
  CatalogDetailPresentationLoader,
  CatalogDetailPresentationPeek,
} from "../detail/load-catalog-detail";
import type {
  CatalogDetailPresentation,
  CatalogDetailPresentationState,
} from "../detail/catalog-detail-presentation";

export interface PreviewCatalogDetailOverlayProps {
  readonly backButtonRef: RefObject<HTMLButtonElement | null>;
  readonly catalogId: string;
  readonly target?: ContentIdentity;
  readonly commentSection?: ReactNode;
  readonly renderColophon?:
    ((target: ContentIdentity, title: string) => ReactNode) | undefined;
  readonly renderActions?: (
    detail: CatalogDetailPresentation,
    refresh: () => void,
  ) => ReactNode;
  readonly initialScrollTop: number;
  readonly loader: CatalogDetailPresentationLoader;
  /**
   * What the Detail shows at once while the loader reads (a work this account
   * already received); the loader's answer then replaces it in place. Absent
   * for the Catalog, which starts in loading.
   */
  readonly peek?: CatalogDetailPresentationPeek | undefined;
  readonly onClose: () => void;
  readonly onScrollTopChange: (top: number) => void;
}

export const PreviewCatalogDetailOverlay = ({
  backButtonRef,
  catalogId,
  target,
  commentSection,
  renderColophon,
  renderActions,
  initialScrollTop,
  loader,
  peek,
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
    browseOnly,
    changeViewerMedia,
    closeViewer,
    feedLayout,
    openViewer,
    orientation,
    platform,
    recoverUnavailableAuthContent,
  } = useProductShell();
  // Browse-only reads without comments (pc-browse-only-v1): undefined, never
  // an empty node, so the Detail keeps its hero layout. The actions themselves
  // keep only the plain author line.
  const readOnly = browseOnly === true;
  const calligraphy = platform !== "pc" && feedLayout === "single";
  const generationRef = useRef(0);
  const missingTargetRef = useRef<ContentIdentity | null>(null);
  // A seed only for a known account: never during a session error or a first
  // check without a viewer, and only when it holds the Viewer's media.
  const seedFor = (id: string) => {
    if (
      peek === undefined ||
      author === null ||
      author.sessionError ||
      (author.checking && author.viewer === null)
    )
      return null;
    const seed = peek(id);
    return seed !== null &&
      (activeViewerMediaId === null ||
        seed.media.some((item) => item.id === activeViewerMediaId))
      ? seed
      : null;
  };
  // The read effect sees the current gating without re-running on it.
  const seedRef = useRef(seedFor);
  seedRef.current = seedFor;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<CatalogDetailPresentationState>(() => {
    const seed = seedFor(catalogId);
    return seed === null
      ? { state: "loading" }
      : { state: "loaded", detail: seed };
  });
  // A seed alone is not an open: content_open waits for the confirming read.
  const provisional =
    state.state === "loaded" &&
    state.detail.contentType === "work" &&
    state.detail.provisional === true;
  useContentAnalytics(
    targetType,
    targetId,
    state.state === "loaded" && !provisional,
  );

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++generationRef.current;
    missingTargetRef.current = null;
    if (peek === undefined) setState({ state: "loading" });
    else {
      // What is shown stays while the read revalidates it: no skeleton.
      const seed = seedRef.current(catalogId);
      setState((current) =>
        current.state === "loaded" && current.detail.id === catalogId
          ? current
          : seed === null
            ? { state: "loading" }
            : { state: "loaded", detail: seed },
      );
    }
    // A failed read keeps the work already shown only while it is still held
    // (a transport failure). A record forgotten by the read (401, 403) shows
    // the answer, and so does a Detail that opened without a known work.
    const settleFailure = (answer: CatalogDetailPresentationState) => {
      missingTargetRef.current = null;
      setState((current) =>
        current.state === "loaded" &&
        current.detail.id === catalogId &&
        seedRef.current(catalogId) !== null
          ? current
          : answer,
      );
    };
    void loader(catalogId, controller.signal)
      .then((nextState) => {
        if (
          !controller.signal.aborted &&
          generationRef.current === generation
        ) {
          if (
            nextState.state === "unavailable" ||
            nextState.state === "unexpected-error"
          ) {
            settleFailure(nextState);
            return;
          }
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
          settleFailure({ state: "unexpected-error" });
        }
      });
    return () => controller.abort();
  }, [catalogId, loader, peek, revision, targetType, targetId]);

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
      calligraphy={calligraphy}
      positionKey={`${author?.viewer?.id ?? "guest"}:${targetType}:${targetId}:${calligraphy ? "calligraphy" : "normal"}`}
      commentSection={readOnly || calligraphy ? undefined : commentSection}
      colophon={
        !readOnly && calligraphy && state.state === "loaded"
          ? (renderColophon?.(
              { type: targetType, id: targetId },
              state.detail.title,
            ) ?? commentSection)
          : undefined
      }
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
