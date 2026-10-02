import type { ArticleBlockNoteEditor } from "./article-blocknote-schema";

/** Reorder siblings atomically; never indent media into a neighbouring list. */
export const moveArticleBlock = (
  editor: ArticleBlockNoteEditor,
  blockId: string,
  targetId: string,
  placement: "before" | "after",
): boolean => {
  const siblings = editor.document;
  const source = siblings.find((block) => block.id === blockId);
  const target = siblings.find((block) => block.id === targetId);
  if (!source || !target || source === target) return false;
  const ids = siblings.map((block) => block.id);
  const order = ids.filter((id) => id !== blockId);
  const targetIndex = order.indexOf(targetId);
  order.splice(targetIndex + (placement === "after" ? 1 : 0), 0, blockId);
  if (order.every((id, index) => id === ids[index])) return false;
  editor.transact(() => {
    editor.removeBlocks([blockId]);
    editor.insertBlocks([source], targetId, placement);
  });
  editor.setTextCursorPosition(blockId, "start");
  editor.focus();
  return true;
};

export const stepArticleBlock = (
  editor: ArticleBlockNoteEditor,
  blockId: string,
  direction: -1 | 1,
) => {
  const siblings = editor.document;
  const index = siblings.findIndex((block) => block.id === blockId);
  const neighbour = siblings[index + direction];
  return index >= 0 && neighbour !== undefined
    ? moveArticleBlock(
        editor,
        blockId,
        neighbour.id,
        direction === -1 ? "before" : "after",
      )
    : false;
};
