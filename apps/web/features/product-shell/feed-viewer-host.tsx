"use client";

import { CatalogViewer } from "../detail/catalog-viewer";

import type { ContentIdentity } from "@moya/contracts";
import type { DetailMediaPresentation } from "../detail/catalog-detail-presentation";
import type { PresentationPlatform } from "../shell/device-platform";

/** A feed post's full-screen viewer, open over the feed without Detail. */
export interface FeedViewerSession {
  readonly target: ContentIdentity;
  readonly media: readonly DetailMediaPresentation[];
  readonly index: number;
  readonly opener: HTMLElement;
  readonly direction: "ltr" | "rtl";
}

export interface FeedViewerHostProps {
  readonly session: FeedViewerSession | null;
  readonly platform: PresentationPlatform;
  readonly onClose: () => void;
  readonly onIndexChange: (index: number) => void;
}

export const FeedViewerHost = ({
  session,
  platform,
  onClose,
  onIndexChange,
}: FeedViewerHostProps) =>
  session === null ? null : (
    <CatalogViewer
      direction={session.direction}
      index={session.index}
      media={session.media}
      onClose={onClose}
      onIndexChange={onIndexChange}
      open
      platform={platform}
    />
  );
