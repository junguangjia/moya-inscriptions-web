"use client";

import { Icon } from "@moya/ui";
import { useId, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { useProductShell } from "../product-shell/product-shell";
import { useUtilityModalIsolation } from "../shell/utility-modal-isolation";
import { resolvePrimaryNavigationViewportInset } from "../shell/primary-navigation-motion";
import styles from "./search.module.css";
import type { ReactNode, RefObject } from "react";

export const SearchTrigger = ({
  open,
  onOpenChange,
  openerRef,
  searchInputRef,
  placement = "dock",
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly openerRef: RefObject<HTMLButtonElement | null>;
  readonly searchInputRef: RefObject<HTMLInputElement | null>;
  /** "header" triggers repeat per destination and never own the shared ref. */
  readonly placement?: "dock" | "header";
}) => (
  <button
    aria-expanded={open}
    aria-haspopup="dialog"
    aria-label="打开搜索"
    title="搜索碑刻、书帖"
    className={`${styles.trigger} yoyi-functional-glass`}
    data-search-trigger=""
    data-search-trigger-placement={
      placement === "header" ? "header" : undefined
    }
    onClick={(event) => {
      // Focus returns to the control actually used, never a hidden sibling.
      openerRef.current = event.currentTarget;
      // Preserve Safari's user activation through the input's first focus.
      flushSync(() => onOpenChange(true));
      searchInputRef.current?.focus({ preventScroll: true });
    }}
    ref={placement === "dock" ? openerRef : undefined}
    type="button"
  >
    <Icon aria-hidden="true" name="search" />
    {placement === "header" && (
      <span className={styles.desktopSearchLabel} aria-hidden="true">
        搜索
      </span>
    )}
  </button>
);

export interface SearchPresentationProps {
  readonly children: ReactNode;
  readonly keyword: string;
  readonly open: boolean;
  readonly onKeywordChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly onClear: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly openerRef: RefObject<HTMLButtonElement | null>;
  readonly searchInputRef?: RefObject<HTMLInputElement | null>;
  readonly contentRef?: RefObject<HTMLDivElement | null>;
  readonly qa?: boolean;
}

export const SearchPresentation = ({
  children,
  keyword,
  open: isOpen,
  onKeywordChange,
  onSubmit,
  onOpenChange,
  openerRef,
  searchInputRef,
  contentRef,
  qa = false,
}: SearchPresentationProps) => {
  const { platform } = useProductShell();
  const overlayRef = useRef<HTMLElement>(null);
  const localInputRef = useRef<HTMLInputElement>(null);
  const inputRef = searchInputRef ?? localInputRef;
  const composingRef = useRef(false);
  const inputId = useId();
  const { close } = useUtilityModalIsolation({
    open: isOpen,
    overlayRef,
    initialFocusRef: inputRef,
    openerRef,
    onRequestClose: () => onOpenChange(false),
  });
  useLayoutEffect(() => {
    // Removing an active input need not emit compositionend (including a
    // controlled switch to another utility). A later session starts fresh.
    if (!isOpen) composingRef.current = false;
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen || overlayRef.current === null) return;
    const overlay = overlayRef.current;
    const viewport = window.visualViewport;
    let frame: number | null = null;
    const synchronize = () => {
      frame = null;
      if (viewport == null) {
        overlay.style.setProperty(
          "--qa-search-viewport-height",
          `${window.innerHeight}px`,
        );
        return;
      }
      overlay.style.setProperty(
        "--qa-search-viewport-height",
        `${viewport.height}px`,
      );
      overlay.style.setProperty(
        "--qa-search-viewport-top",
        `${viewport.offsetTop}px`,
      );
      overlay.style.setProperty(
        "--qa-search-viewport-left",
        `${viewport.offsetLeft}px`,
      );
      overlay.style.setProperty(
        "--qa-search-viewport-width",
        `${viewport.width}px`,
      );
      const inset = resolvePrimaryNavigationViewportInset(
        window.innerHeight,
        viewport.height,
        viewport.offsetTop,
      );
      // Already bounded by the visual viewport: do not add keyboard inset again.
      overlay.style.setProperty(
        "--qa-search-bottom-safe-area",
        inset > 1 ? "0px" : "env(safe-area-inset-bottom)",
      );
    };
    const schedule = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(synchronize);
    };
    synchronize();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    return () => {
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [isOpen]);

  const submit = () => {
    const value = keyword.trim();
    if (composingRef.current || value.length === 0) return;
    onSubmit(value);
    inputRef.current?.blur();
  };
  return (
    <div
      className={styles.root}
      data-open={isOpen ? "" : undefined}
      data-platform={platform}
      data-t02p-qa-search={qa ? "" : undefined}
      data-catalog-search={qa ? undefined : ""}
    >
      {isOpen ? (
        <section
          aria-label={qa ? "QA 搜索" : "搜索"}
          aria-modal="true"
          className={styles.panel}
          data-search-panel=""
          ref={overlayRef}
          role="dialog"
          tabIndex={-1}
        >
          <div
            className={styles.content}
            data-search-content=""
            ref={contentRef}
          >
            {children}
          </div>
          <div className={styles.composer} data-search-composer="">
            <form
              className={`${styles.form} yoyi-functional-glass`}
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
              role="search"
            >
              <button
                aria-label="提交搜索"
                className={styles.submit}
                data-search-submit=""
                type="submit"
              >
                <Icon aria-hidden="true" name="search" />
              </button>
              <label className={styles.visuallyHidden} htmlFor={inputId}>
                搜索关键词
              </label>
              <input
                autoComplete="off"
                enterKeyHint="search"
                id={inputId}
                onChange={(event) => {
                  onKeywordChange(event.currentTarget.value);
                }}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (composingRef.current ||
                      event.nativeEvent.isComposing ||
                      event.nativeEvent.keyCode === 229)
                  )
                    event.preventDefault();
                }}
                placeholder="搜索碑刻、书帖……"
                ref={inputRef}
                type="search"
                value={keyword}
              />
            </form>
            <button
              aria-label="关闭搜索"
              className={`${styles.close} yoyi-functional-glass`}
              data-search-close=""
              onClick={close}
              type="button"
            >
              <Icon aria-hidden="true" name="close" />
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
};
