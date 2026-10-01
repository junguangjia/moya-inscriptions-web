"use client";

import { Icon } from "@moya/ui";
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useMemo,
} from "react";

import { useAuthors } from "../authors/author-context";
import detailStyles from "../detail/catalog-detail.module.css";
import { useProductShell } from "../product-shell/product-shell";
import styles from "./publishing-entry.module.css";

import type { ReactNode } from "react";
import type { EditorTarget } from "../product-shell/product-history";
import type { ProductShellEditorOverlayControls } from "../product-shell/product-shell";

/** Renders the editor for one account inside the history-owned host. */
export type PublishingEditorRenderer = (
  target: EditorTarget,
  controls: ProductShellEditorOverlayControls,
) => ReactNode;

interface PublishingEntryValue {
  readonly renderEditor: PublishingEditorRenderer | null;
}

const PublishingEntryContext = createContext<PublishingEntryValue | null>(null);

/** Author composition only: registers the editor renderer, if any. */
export const PublishingEntryProvider = ({
  children,
  renderEditor = null,
}: {
  readonly children: ReactNode;
  readonly renderEditor?: PublishingEditorRenderer | null;
}) => {
  const value = useMemo(() => ({ renderEditor }), [renderEditor]);
  return (
    <PublishingEntryContext.Provider value={value}>
      {children}
    </PublishingEntryContext.Provider>
  );
};

/**
 * Opens the editor for a signed-in author and reports whether it opened. A
 * guest reaches the existing sign-in center instead of an editor that could
 * never save.
 */
export const usePublishingEntry = () => {
  const entry = useContext(PublishingEntryContext);
  if (entry === null) throw new Error("Publishing entry requires its provider");
  const { checking, viewer } = useAuthors();
  const { openEditor: openShellEditor, openProfile } = useProductShell();
  const signedIn = viewer !== null;
  const openEditor = useCallback(
    (target: EditorTarget, opener: HTMLElement) => {
      if (checking) return false;
      if (signedIn) return openShellEditor(target, opener);
      openProfile(null, opener);
      return false;
    },
    [checking, openProfile, openShellEditor, signedIn],
  );
  return { checking, openEditor };
};

const editorTitles = {
  new: "发布作品",
  draft: "编辑草稿",
  work: "编辑作品",
} as const satisfies Record<EditorTarget["type"], string>;

export const PublishingEditorOverlay = ({
  target,
  controls,
}: {
  readonly target: EditorTarget;
  readonly controls: ProductShellEditorOverlayControls;
}) => {
  const entry = useContext(PublishingEntryContext);
  const author = useAuthors();
  const title =
    target.type === "new" && target.threadId
      ? "参与话题"
      : editorTitles[target.type];
  return (
    <section
      aria-label={title}
      aria-modal="true"
      className={`${detailStyles.experience} ${styles.host}`}
      data-publishing-editor={target.type}
      role="dialog"
    >
      <header className={`${detailStyles.detailHeader} ${styles.bar}`}>
        <button
          ref={controls.backButtonRef}
          aria-label="返回"
          onClick={controls.close}
          type="button"
        >
          <Icon aria-hidden="true" name="back" />
        </button>
        <strong className={styles.title}>{title}</strong>
        <span aria-hidden="true" className={styles.balance} />
      </header>
      <div className={styles.body} data-publishing-editor-body="">
        {author.viewer !== null ? (
          // A different account never inherits another account's session.
          <Fragment key={author.viewer.id}>
            {entry?.renderEditor?.(target, controls)}
          </Fragment>
        ) : author.checking ? null : (
          <div className={styles.guest}>
            <p>登录后可发布与编辑作品。</p>
            <div className="phase4-actions">
              <a href={author.signInHref}>登录</a>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

export const renderPublishingEditorOverlay = (
  target: EditorTarget,
  controls: ProductShellEditorOverlayControls,
) => <PublishingEditorOverlay controls={controls} target={target} />;
