import { getBlockInfoAtNearest, getNodeId } from "@blocknote/core";
import type { ArticleDocument, ArticleMediaReference } from "@moya/contracts";
import {
  articleAuthoringLimits,
  parseArticleEditorDocument,
} from "../../../lib/public-api/article-authoring-client";
import { attachArticleReferences } from "./article-attachments";
import type { ArticleBlockNoteEditor } from "./article-blocknote-schema";
import { articleImageCropProps } from "./article-image-layout";
import { ArticleFileImportError } from "./article-file-import";

const externalFiles = (event: DragEvent) =>
  event.dataTransfer !== null &&
  Array.from(event.dataTransfer.types).includes("Files") &&
  !Array.from(event.dataTransfer.types).includes("blocknote/html");

const dropTarget = (
  editor: ArticleBlockNoteEditor,
  view: ArticleBlockNoteEditor["prosemirrorView"],
  event: DragEvent,
) => {
  const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
  const id =
    pos === null
      ? undefined
      : getNodeId(
          getBlockInfoAtNearest(view.state, pos.pos).bnBlock.node,
          view.state.doc,
        );
  const contains = (
    block: ArticleBlockNoteEditor["document"][number],
  ): boolean => block.id === id || block.children.some(contains);
  const elements = new Map<string, HTMLElement>();
  for (const element of Array.from(
    editor.domElement?.querySelectorAll<HTMLElement>("[data-id]") ?? [],
  )) {
    const id = element.dataset.id;
    if (id && !elements.has(id)) elements.set(id, element);
  }
  const measured = editor.document.flatMap((block) => {
    const element = elements.get(block.id);
    const rect = element?.getBoundingClientRect();
    return element && rect && rect.bottom > rect.top
      ? [{ block, element, rect }]
      : [];
  });
  // Whitespace has no text hit. Use its Y coordinate, including body margins/tail.
  const distance = (rect: DOMRect) =>
    Math.max(rect.top - event.clientY, event.clientY - rect.bottom, 0);
  const nearest = measured.reduce<(typeof measured)[number] | undefined>(
    (best, value) =>
      best === undefined || distance(value.rect) < distance(best.rect)
        ? value
        : best,
    undefined,
  );
  const native = editor.document.find(contains);
  const nativeRect = measured.find(
    (value) => value.block.id === native?.id,
  )?.rect;
  const target =
    nativeRect &&
    event.clientY >= nativeRect.top &&
    event.clientY <= nativeRect.bottom
      ? native
      : (nearest?.block ?? native);
  if (target === undefined) return null;
  const element = elements.get(target.id);
  const rect = element?.getBoundingClientRect();
  const placement =
    rect && (rect.top + rect.bottom) / 2 > event.clientY
      ? ("before" as const)
      : ("after" as const);
  let boundary: number | null = null;
  view.state.doc.descendants((node, nodePos) => {
    if (
      node.type.name === "blockContainer" &&
      getNodeId(node, view.state.doc) === target.id
    ) {
      boundary = placement === "before" ? nodePos : nodePos + node.nodeSize;
      return false;
    }
    return true;
  });
  return boundary === null
    ? null
    : {
        target,
        element,
        placement,
        cursor: { pos: boundary, orientation: "block-horizontal" as const },
      };
};

/** Adapt native file-drop geometry to ready managed refs, without URL placeholders. */
export const createArticleFileDrop = (options: {
  readonly editor: ArticleBlockNoteEditor;
  readonly surface?: HTMLElement | null;
  readonly canImport: () => boolean;
  readonly importFiles: (
    files: File[],
    signal: AbortSignal,
    allowed: () => boolean,
  ) => Promise<readonly ArticleMediaReference[]>;
  readonly attachments: () => Pick<ArticleDocument, "references" | "galleries">;
  readonly setAttachments: (
    value: Pick<ArticleDocument, "references" | "galleries">,
  ) => void;
  readonly nextId: () => string;
  readonly changed: () => void;
  readonly pending: (value: boolean) => void;
  readonly notice: (value: string) => void;
}) => {
  const { editor } = options;
  const lifetime = new AbortController();
  let pending = false;
  const allowed = () => !lifetime.signal.aborted && options.canImport();
  const modalOpen = () =>
    Boolean(
      (options.surface ?? editor.domElement)?.querySelector("dialog[open]"),
    );
  let marked: HTMLElement | undefined;
  const clearMarker = () => {
    if (marked) delete marked.dataset.articleFileDrop;
    marked = undefined;
  };
  const adapter = {
    cursorPosition(
      view: ArticleBlockNoteEditor["prosemirrorView"],
      event: DragEvent,
    ) {
      return allowed() && editor.isEditable && !pending && !modalOpen()
        ? (dropTarget(editor, view, event)?.cursor ?? null)
        : null;
    },
    externalFiles,
    handleDrop(
      view: ArticleBlockNoteEditor["prosemirrorView"],
      event: DragEvent,
    ) {
      const transfer = event.dataTransfer;
      // Internal BlockNote drags keep the native side-menu, nesting guard and undo.
      if (!externalFiles(event)) return false;
      event.preventDefault();
      if (modalOpen()) {
        clearMarker();
        return true;
      }
      if (!allowed() || !editor.isEditable) return true;
      if (pending) {
        options.notice("上一批图片仍在上传，请稍后再拖入。");
        return true;
      }
      const files = Array.from(transfer!.files);
      // Media remains top-level even when the native pointer is inside a list.
      const destination = dropTarget(editor, view, event);
      if (destination === null || files.length === 0) return true;
      const { target, placement } = destination;
      pending = true;
      options.pending(true);
      void (async () => {
        try {
          const refs = await options.importFiles(
            files,
            lifetime.signal,
            allowed,
          );
          if (!allowed()) return;
          if (refs.length === 0) {
            options.notice("未插入图片，可从工具栏重新选择素材。");
            return;
          }
          if (!editor.document.some((block) => block.id === target.id))
            throw new ArticleFileImportError(
              "放置位置已被删除。图片已保留在素材中，请重新插入。",
            );
          const attached = attachArticleReferences(
            options.attachments(),
            refs,
            options.nextId,
          );
          if (
            Object.keys(attached.attachments.references).length >
            articleAuthoringLimits.imageReferences
          )
            throw new ArticleFileImportError(
              "正文图片数量已达上限。图片已保留在素材中。",
            );
          const blocks = attached.referenceIds.map((refId) => ({
            id: options.nextId(),
            type: "managedImage" as const,
            props: {
              refId,
              caption: "",
              alt: "",
              ...articleImageCropProps(null),
              displayWidth: 1,
            },
          }));
          const candidate = [...editor.document];
          const index = candidate.findIndex((block) => block.id === target.id);
          candidate.splice(
            index + (placement === "after" ? 1 : 0),
            0,
            ...blocks.map((block) => ({
              ...block,
              content: undefined,
              children: [],
            })),
          );
          try {
            parseArticleEditorDocument(candidate, attached.attachments);
          } catch {
            throw new ArticleFileImportError(
              "正文内容已达上限，请调整后重新插入图片。",
            );
          }
          // Maps precede the transaction so canonical autosave observes complete refs.
          options.setAttachments(attached.attachments);
          editor.transact(() =>
            editor.insertBlocks(blocks, target.id, placement),
          );
          options.changed();
          options.notice(`已插入 ${blocks.length} 张图片。`);
        } catch (error) {
          if (!lifetime.signal.aborted)
            options.notice(
              error instanceof ArticleFileImportError
                ? error.message
                : "暂时无法插入图片，请重试。",
            );
        } finally {
          pending = false;
          if (!lifetime.signal.aborted) options.pending(false);
        }
      })();
      return true;
    },
    dispose: () => {
      lifetime.abort();
      clearMarker();
      options.surface?.removeEventListener("dragover", dragOver);
      options.surface?.removeEventListener("dragleave", dragLeave);
      options.surface?.removeEventListener("dragend", clearMarker);
      options.surface?.removeEventListener("drop", surfaceDrop);
    },
  };
  const insideEditor = (event: DragEvent) =>
    event.target instanceof Node &&
    editor.prosemirrorView.dom.contains(event.target);
  const dragOver = (event: DragEvent) => {
    clearMarker();
    if (!externalFiles(event)) return;
    if (modalOpen()) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer!.dropEffect = "none";
      return;
    }
    const view = editor.prosemirrorView;
    // Native BlockNote owns text-hit indicators; only fill its whitespace gap.
    if (
      insideEditor(event) &&
      view.posAtCoords({ left: event.clientX, top: event.clientY }) !== null
    )
      return;
    event.preventDefault();
    // This task owns external whitespace drags. Do not let the document-level
    // SideMenu replace their coordinates or clear this surface's indicator.
    event.stopPropagation();
    const destination =
      allowed() && editor.isEditable && !pending
        ? dropTarget(editor, view, event)
        : null;
    event.dataTransfer!.dropEffect = destination ? "copy" : "none";
    if (destination?.element) {
      marked = destination.element;
      marked.dataset.articleFileDrop = destination.placement;
    }
  };
  const dragLeave = (event: DragEvent) => {
    if (
      event.relatedTarget instanceof Node &&
      options.surface?.contains(event.relatedTarget)
    )
      return;
    clearMarker();
  };
  const surfaceDrop = (event: DragEvent) => {
    clearMarker();
    if (externalFiles(event) && modalOpen()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // A bubbling PM drop was already handled once by the native DOM hook.
    if (event.defaultPrevented || insideEditor(event)) return;
    if (adapter.handleDrop(editor.prosemirrorView, event))
      event.stopPropagation();
  };
  options.surface?.addEventListener("dragover", dragOver);
  options.surface?.addEventListener("dragleave", dragLeave);
  options.surface?.addEventListener("dragend", clearMarker);
  options.surface?.addEventListener("drop", surfaceDrop);
  return adapter;
};
