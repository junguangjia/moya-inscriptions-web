"use client";

import {
  createRef,
  memo,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { UNTITLED_WORK_LABEL } from "../../../authors/content-card";
import { toWorkAuthorshipPresentation } from "../../../detail/catalog-detail-presentation";
import { CatalogDetailScreen } from "../../../detail/catalog-detail-screen";
import detailStyles from "../../../detail/catalog-detail.module.css";
import { sharedPreviewCache } from "../media/bounded-preview";
import { renderEditedFrame } from "../media/edited-frame";
import { bodyRule, checkEditorText, titleRule } from "./editor-text";
import styles from "./editor.module.css";

import type {
  CatalogDetailPresentation,
  DetailMediaPresentation,
} from "../../../detail/catalog-detail-presentation";
import type {
  PresentationOrientation,
  PresentationPlatform,
} from "../../../shell/device-platform";
import type { BoundedImage, PreviewHandle } from "../media/bounded-preview";
import type { EditedFrameImage } from "../media/edited-frame";
import type { UploadManagerSnapshot } from "../../upload-manager";
import type { EditorSessionState } from "./editor-session-state";
import type { MediaEdit, WorkAuthorship } from "@moya/contracts";

/** UI-only placeholder for an empty title (C07); never stored. */
export const UNNAMED_WORK = UNTITLED_WORK_LABEL;

/** Placeholder frame until a local image reports its size. */
const FALLBACK_SIZE = { width: 1200, height: 900 } as const;

/** Long edge of preview images: enough for the preview column and a phone. */
export const PREVIEW_EDGE = 1280;

export interface EditorMediaSource {
  readonly key: string;
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly live?: {
    readonly motionSrc: string;
    readonly hasAudio: boolean;
  };
}

/** Which album items need a picture now. */
export type EditorMediaScope = "all" | "cover" | "none";

export interface EditorMediaSources {
  readonly sources: readonly EditorMediaSource[];
  /** Items whose rotation or crop could not be drawn (shown unedited). */
  readonly unedited: number;
}

const identityEdit = (edit: MediaEdit) =>
  edit.rotation === 0 && edit.crop === null;

const editKey = (src: string, edit: MediaEdit) =>
  `${src}|${edit.rotation}|${
    edit.crop === null
      ? "full"
      : `${edit.crop.x},${edit.crop.y},${edit.crop.width},${edit.crop.height}`
  }`;

interface BoundedEntry {
  readonly handle: PreviewHandle;
  /** undefined while decoding; null when no picture could be made. */
  image: BoundedImage | null | undefined;
}

interface EditedEntry {
  /** undefined while drawing; null when the frame could not be drawn. */
  image: EditedFrameImage | null | undefined;
  released: boolean;
}

type Base =
  | {
      readonly key: string;
      readonly edit: MediaEdit;
      readonly src: string;
      readonly width: number;
      readonly height: number;
      readonly live?: EditorMediaSource["live"];
    }
  | { readonly key: string; readonly edit: MediaEdit; readonly blob: Blob };

/**
 * Pictures of the album as it will be presented, only for the items in
 * `scope` (nothing is decoded while no preview or cover is shown):
 * - an item the account has made ready uses its display derivative;
 * - an item still on this device uses a bounded local copy (shared with the
 *   media section's previews, released when no longer shown);
 * - rotation and crop are drawn into a bounded edited frame, like the
 *   published derivatives; a Live Photo with an edit shows its edited still.
 *   Until a frame is drawn the unedited picture is shown; where it cannot be
 *   drawn the item is counted in `unedited`.
 */
export const useEditorMediaSources = (
  state: EditorSessionState,
  uploads: UploadManagerSnapshot | null,
  localStill: (key: string) => Blob | null,
  scope: EditorMediaScope,
): EditorMediaSources => {
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  const bounded = useRef(new Map<Blob, BoundedEntry>());
  const edited = useRef(new Map<string, EditedEntry>());
  const cached = useRef<{
    readonly signature: string;
    readonly value: EditorMediaSources;
  } | null>(null);

  const views = useMemo(
    () => new Map((uploads?.items ?? []).map((item) => [item.key, item])),
    [uploads],
  );

  const coverKey = state.coverKey ?? state.items[0]?.key ?? null;
  const shown =
    scope === "all"
      ? state.items
      : scope === "cover"
        ? state.items.filter((item) => item.key === coverKey)
        : [];

  const bases = shown.flatMap((item): Base[] => {
    const view = views.get(item.key);
    const server =
      view?.serverItem ??
      (item.itemId === null ? undefined : state.serverItems[item.itemId]);
    if (server?.media && server.presentation) {
      const motionSrc = server.media.motionSrc;
      return [
        {
          key: item.key,
          edit: item.edit,
          src: server.media.displaySrc,
          width: server.presentation.width,
          height: server.presentation.height,
          ...(server.kind === "live" && motionSrc !== undefined
            ? {
                live: {
                  motionSrc,
                  hasAudio: server.presentation.hasAudio === true,
                },
              }
            : {}),
        },
      ];
    }
    const blob = localStill(item.key);
    return blob === null ? [] : [{ key: item.key, edit: item.edit, blob }];
  });

  const unedited = (base: Base): EditorMediaSource | null => {
    if ("src" in base)
      return {
        key: base.key,
        src: base.src,
        width: base.width,
        height: base.height,
        ...(base.live === undefined ? {} : { live: base.live }),
      };
    const image = bounded.current.get(base.blob)?.image;
    return image
      ? { key: base.key, src: image.url, ...(image.size ?? FALLBACK_SIZE) }
      : null;
  };

  let failed = 0;
  const wantedEdits = new Map<
    string,
    { readonly src: string; readonly edit: MediaEdit }
  >();
  const sources = bases.flatMap((base): EditorMediaSource[] => {
    const plain = unedited(base);
    if (plain === null) return [];
    if (identityEdit(base.edit)) return [plain];
    const key = editKey(plain.src, base.edit);
    wantedEdits.set(key, { src: plain.src, edit: base.edit });
    const entry = edited.current.get(key);
    if (entry?.image)
      return [
        {
          key: base.key,
          src: entry.image.url,
          width: entry.image.size.width,
          height: entry.image.size.height,
        },
      ];
    if (entry?.image === null) failed += 1;
    return [plain];
  });

  const wantedBlobs = new Set(
    bases.flatMap((base) => ("blob" in base ? [base.blob] : [])),
  );

  // Decoding, drawing and releasing happen outside render.
  useEffect(() => {
    for (const [blob, entry] of bounded.current)
      if (!wantedBlobs.has(blob)) {
        entry.handle.release();
        bounded.current.delete(blob);
      }
    for (const blob of wantedBlobs) {
      if (bounded.current.has(blob)) continue;
      const handle = sharedPreviewCache().acquire(blob, PREVIEW_EDGE);
      const entry: BoundedEntry = { handle, image: undefined };
      bounded.current.set(blob, entry);
      void handle.result.then((image) => {
        if (bounded.current.get(blob) !== entry) return;
        entry.image = image;
        redraw();
      });
    }
    for (const [key, entry] of edited.current)
      if (!wantedEdits.has(key)) {
        entry.released = true;
        entry.image?.release();
        edited.current.delete(key);
      }
    for (const [key, wanted] of wantedEdits) {
      if (edited.current.has(key)) continue;
      const entry: EditedEntry = { image: undefined, released: false };
      edited.current.set(key, entry);
      renderEditedFrame(wanted.src, wanted.edit, PREVIEW_EDGE).then(
        (image) => {
          if (entry.released) {
            image.release();
            return;
          }
          entry.image = image;
          redraw();
        },
        () => {
          if (entry.released) return;
          entry.image = null;
          redraw();
        },
      );
    }
  });

  useEffect(() => {
    const boundedEntries = bounded.current;
    const editedEntries = edited.current;
    return () => {
      for (const entry of boundedEntries.values()) entry.handle.release();
      boundedEntries.clear();
      for (const entry of editedEntries.values()) {
        entry.released = true;
        entry.image?.release();
      }
      editedEntries.clear();
    };
  }, []);

  // The same value while nothing shown changes (typing never redraws media).
  const signature = JSON.stringify([
    sources.map((source) => [
      source.key,
      source.src,
      source.width,
      source.height,
      source.live?.motionSrc ?? null,
      source.live?.hasAudio ?? null,
    ]),
    failed,
  ]);
  const previous = cached.current;
  if (previous !== null && previous.signature === signature)
    return previous.value;
  const value = { sources, unedited: failed };
  cached.current = { signature, value };
  return value;
};

/** The real work presentation (Detail) built from the editor's local state. */
export const editorPreviewPresentation = (
  state: Pick<EditorSessionState, "title" | "body" | "workId"> & {
    /** The authorship section readers will see; null (or absent) shows none. */
    readonly authorship?: WorkAuthorship | null;
  },
  media: readonly EditorMediaSource[],
  author: {
    readonly id: string;
    readonly displayName: string;
    readonly studioName?: string | undefined;
  },
): CatalogDetailPresentation => {
  const title = checkEditorText(state.title, titleRule).value;
  const body = checkEditorText(state.body, bodyRule).value;
  const alt = title === "" ? UNNAMED_WORK : title;
  return {
    contentType: "work",
    id: state.workId ?? "work-preview",
    authorId: author.id,
    authorName: author.displayName,
    authorStudioName: author.studioName,
    canEdit: false,
    available: true,
    title,
    aliases: [],
    facts: [],
    sections:
      body === "" ? [] : [{ key: "description", title: "正文", text: body }],
    ...(state.authorship === undefined || state.authorship === null
      ? {}
      : { authorship: toWorkAuthorshipPresentation(state.authorship) }),
    media: media.map((entry, index): DetailMediaPresentation => ({
      id: entry.key,
      src: entry.src,
      alt: media.length > 1 ? `${alt}（第 ${index + 1} 项）` : alt,
      width: entry.width,
      height: entry.height,
      ...(entry.live === undefined ? {} : { live: entry.live }),
    })),
    source: "runtime",
    sourceCitations: [],
  };
};

const usePreviewIndex = (count: number) => {
  const [index, setIndex] = useState(0);
  return [Math.min(index, Math.max(0, count - 1)), setIndex] as const;
};

const UneditedNote = ({ count }: { readonly count: number }) =>
  count === 0 ? null : (
    <p className={styles.hint} data-editor-preview-unedited="">
      {count} 项图片的旋转或裁切无法在预览中显示，发布后按编辑结果展示。
    </p>
  );

/**
 * Desktop and wide tablet (E05): the continuous preview beside the editor.
 * It is a picture of the result, not a second place to act, so it is inert.
 */
export const ContinuousPreview = memo(function ContinuousPreview({
  presentation,
  unedited,
}: {
  readonly presentation: CatalogDetailPresentation;
  readonly unedited: number;
}) {
  const [index, setIndex] = usePreviewIndex(presentation.media.length);
  const backRef = useMemo(() => createRef<HTMLButtonElement>(), []);
  return (
    <section
      aria-label="预览"
      className={styles.previewColumn}
      data-editor-preview="continuous"
    >
      <h2 className={styles.sectionTitle}>预览</h2>
      <UneditedNote count={unedited} />
      <div className={styles.previewFrame} inert>
        <CatalogDetailScreen
          activeMediaIndex={index}
          backButtonRef={backRef}
          onActiveMediaIndexChange={setIndex}
          onBack={() => undefined}
          onOpenViewer={() => undefined}
          orientation="portrait"
          platform="phone"
          state={{ state: "loaded", detail: presentation }}
        />
      </div>
    </section>
  );
});

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Phone (E05): 预览 opens the same presentation full screen as a modal
 * layer (the editor behind it is inert); its Back, Escape or the browser's
 * Back (through the editor's leave guard) return to the step with focus on
 * 预览.
 */
export const PhonePreview = ({
  presentation,
  unedited,
  platform,
  orientation,
  onClose,
  opener = null,
}: {
  readonly presentation: CatalogDetailPresentation;
  readonly unedited: number;
  readonly platform: PresentationPlatform;
  readonly orientation: PresentationOrientation;
  readonly onClose: () => void;
  /** The control that opened the preview (Safari does not focus clicked buttons). */
  readonly opener?: HTMLElement | null;
}) => {
  const [index, setIndex] = usePreviewIndex(presentation.media.length);
  const backRef = useRef<HTMLButtonElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const latest = useRef(onClose);
  latest.current = onClose;
  const openerRef = useRef(opener);

  useEffect(() => {
    const opener =
      openerRef.current ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    backRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        latest.current();
        return;
      }
      const layer = layerRef.current;
      if (event.key !== "Tab" || layer === null) return;
      // Focus stays inside the preview while it is open.
      const focusable = Array.from(
        layer.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter((element) => element.closest("[inert]") === null);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      const inside = active !== null && layer.contains(active);
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  return (
    // The Detail screen inside is itself the modal dialog.
    <div
      ref={layerRef}
      className={`${detailStyles.experience} ${styles.phonePreview}`}
      data-editor-preview="phone"
    >
      <div className={detailStyles.detailScroller}>
        <CatalogDetailScreen
          activeMediaIndex={index}
          backButtonRef={backRef}
          onActiveMediaIndexChange={setIndex}
          onBack={onClose}
          onOpenViewer={() => undefined}
          orientation={orientation}
          platform={platform}
          state={{ state: "loaded", detail: presentation }}
        />
        {unedited === 0 ? null : (
          <div className={styles.previewNote}>
            <UneditedNote count={unedited} />
          </div>
        )}
      </div>
    </div>
  );
};
