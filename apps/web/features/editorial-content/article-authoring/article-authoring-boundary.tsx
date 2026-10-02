"use client";

import dynamic from "next/dynamic";
import type { ArticleEditorProps } from "./article-editor-props";

const ArticleEditor = dynamic(() => import("./article-editor"), {
  ssr: false,
  loading: () => <p role="status">正在打开专题编辑器…</p>,
});

/** The existing ProductShell host calls this only while its authoring entry is active. */
export const ArticleAuthoringBoundary = (
  props: ArticleEditorProps & { readonly active: boolean },
) =>
  props.active ? <ArticleEditor key={props.sessionKey} {...props} /> : null;
