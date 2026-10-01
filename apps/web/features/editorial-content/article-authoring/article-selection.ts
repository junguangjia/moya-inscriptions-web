import type { ArticleBlockNoteEditor } from "./article-blocknote-schema";

export const captureArticleSelection = (editor: ArticleBlockNoteEditor) =>
  editor.transact((transaction) => ({
    editor,
    document: transaction.doc,
    bookmark: transaction.selection.getBookmark(),
    anchor: transaction.selection.anchor,
    empty: transaction.selection.empty,
    text: editor.getSelectedText(),
    link: editor.getLinkMarkAtPos(transaction.selection.anchor),
  }));

export type ArticleSelection = ReturnType<typeof captureArticleSelection>;

/** Native modal makes the document inert; refuse a changed document/lifetime. */
export const restoreArticleSelection = (
  editor: ArticleBlockNoteEditor,
  captured: ArticleSelection,
) => {
  if (
    editor !== captured.editor ||
    !editor.prosemirrorState.doc.eq(captured.document)
  )
    return false;
  editor.transact((transaction) =>
    transaction.setSelection(captured.bookmark.resolve(transaction.doc)),
  );
  return true;
};
