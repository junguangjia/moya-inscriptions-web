"use client";

import {
  forwardRef,
  useCallback,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Icon } from "@moya/ui";
import { AuthorDialog } from "../authors/author-dialog";
import type { AuthorDialogNavigationHandle } from "../authors/author-dialog";
import { useAuthReturnView } from "../auth/auth-return";
import {
  isLegacyRtlScroll,
  readStripOffset,
} from "../authors/feed-post-strip-geometry";
import { CatalogDetailReadingStrip } from "./catalog-detail-reading-strip";
import type { CatalogDetailReadingStripHandle } from "./catalog-detail-reading-strip";
import styles from "./desktop-archive-reader.module.css";

export interface DesktopArchiveSection {
  readonly key: string;
  readonly label: string;
  readonly content: ReactNode;
}
export interface DesktopArchiveReaderHandle {
  readonly focus: () => void;
}

// Only the selected category lives here. The existing ReadingStrip owns each
// category's character anchor, native RTL position, copy and auth return.
const selectedSections = new Map<string, string>();
const appliedSelections = new WeakMap<
  { readonly section: string },
  Set<string>
>();
const rememberSection = (key: string, value: string) => {
  selectedSections.delete(key);
  selectedSections.set(key, value);
  if (selectedSections.size > 60)
    selectedSections.delete(selectedSections.keys().next().value!);
};

export const DesktopArchiveReader = forwardRef<
  DesktopArchiveReaderHandle,
  {
    readonly detailId: string;
    readonly label: string;
    readonly positionKey?: string | undefined;
    readonly sections: readonly DesktopArchiveSection[];
  }
>(function DesktopArchiveReader(
  { detailId, label, positionKey, sections },
  ref,
) {
  const root = useRef<HTMLElement>(null);
  const reader = useRef<CatalogDetailReadingStripHandle>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<AuthorDialogNavigationHandle>(null);
  const id = useId();
  const scope =
    positionKey === undefined ? undefined : `${positionKey}:archive:r5`;
  const latestActive = useRef(sections[0]!.key);
  const returned = useAuthReturnView(
    `desktop-archive-category:${detailId}`,
    () => ({ section: latestActive.current }),
  );
  const [selected, setSelected] = useState(() => {
    const validSeed =
      returned !== undefined &&
      sections.some((section) => section.key === returned.section);
    const seeded =
      returned !== undefined &&
      scope !== undefined &&
      appliedSelections.get(returned)?.has(scope);
    return validSeed && !seeded
      ? returned.section
      : scope === undefined
        ? undefined
        : selectedSections.get(scope);
  });
  const [expanded, setExpanded] = useState(false);
  const wasExpanded = useRef(false);
  const active =
    sections.find((section) => section.key === selected) ?? sections[0]!;
  const activeKey = active.key;
  latestActive.current = activeKey;
  useLayoutEffect(() => {
    const hasSeed =
      returned !== undefined && typeof returned.section === "string";
    const seeded =
      hasSeed &&
      scope !== undefined &&
      appliedSelections.get(returned)?.has(scope);
    const saved =
      hasSeed && !seeded
        ? returned.section
        : scope === undefined
          ? undefined
          : selectedSections.get(scope);
    if (
      saved !== undefined &&
      sections.some((section) => section.key === saved)
    ) {
      setSelected(saved);
      if (hasSeed && scope !== undefined && !seeded) {
        const scopes = appliedSelections.get(returned) ?? new Set<string>();
        scopes.add(scope);
        appliedSelections.set(returned, scopes);
        rememberSection(scope, saved);
      }
    }
    return () => {
      if (scope !== undefined) rememberSection(scope, latestActive.current);
    };
  }, [returned, scope]);
  const select = (key: string) => {
    reader.current?.checkpoint();
    setSelected(key);
    if (scope !== undefined) rememberSection(scope, key);
  };
  const [paging, setPaging] = useState({
    forward: false,
    backward: false,
    progress: 0,
  });
  const focus = useCallback(
    () =>
      root.current
        ?.querySelector<HTMLElement>("[data-detail-reading-strip]")
        ?.focus({ preventScroll: true }),
    [],
  );
  useImperativeHandle(ref, () => ({ focus }), [focus]);
  useLayoutEffect(() => {
    if (wasExpanded.current && !expanded)
      expandButton.current?.focus({ preventScroll: true });
    wasExpanded.current = expanded;
  }, [expanded]);
  useLayoutEffect(() => {
    const node = root.current?.querySelector<HTMLElement>(
      "[data-detail-reading-strip]",
    );
    if (!node) return;
    let frame = 0;
    const measure = () => {
      const bounds = reader.current?.pagingState();
      if (!bounds) return;
      const range = node.scrollWidth - node.clientWidth;
      const progress =
        range <= 1
          ? 0
          : Math.round(
              Math.min(
                1,
                readStripOffset(node, isLegacyRtlScroll(node)) / range,
              ) * 100,
            );
      setPaging((old) =>
        old.forward === bounds.forward &&
        old.backward === bounds.backward &&
        old.progress === progress
          ? old
          : { ...bounds, progress },
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    resize?.observe(node);
    for (const child of node.children) resize?.observe(child);
    const mutation = new MutationObserver(schedule);
    mutation.observe(node, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    node.addEventListener("scroll", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      mutation.disconnect();
      node.removeEventListener("scroll", schedule);
    };
  }, [activeKey, expanded]);

  const frame = (full: boolean) => {
    const prefix = `${id}-${full ? "full" : "inline"}`;
    const many = sections.length > 1;
    return (
      <div
        className={styles.frame}
        data-archive-frame=""
        data-one-section={many ? undefined : ""}
      >
        {many ? (
          <div
            className={styles.index}
            role="tablist"
            aria-label="资料分类"
            aria-orientation="vertical"
          >
            {sections.map((section, index) => (
              <button
                key={section.key}
                id={`${prefix}-${section.key}`}
                type="button"
                role="tab"
                aria-selected={section.key === activeKey}
                aria-controls={`${prefix}-panel`}
                tabIndex={section.key === activeKey ? 0 : -1}
                onClick={() => select(section.key)}
                onKeyDown={(event) => {
                  const next =
                    event.key === "ArrowDown"
                      ? (index + 1) % sections.length
                      : event.key === "ArrowUp"
                        ? (index + sections.length - 1) % sections.length
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? sections.length - 1
                            : null;
                  if (next === null) return;
                  event.preventDefault();
                  select(sections[next]!.key);
                  const tabs =
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                      "[role=tab]",
                    );
                  tabs?.item(next).focus();
                }}
              >
                {section.label}
              </button>
            ))}
          </div>
        ) : null}
        <div
          className={styles.canvas}
          id={`${prefix}-panel`}
          role={many ? "tabpanel" : "region"}
          aria-labelledby={many ? `${prefix}-${activeKey}` : undefined}
          aria-label={many ? undefined : active.label}
          data-archive-section={activeKey}
        >
          <CatalogDetailReadingStrip
            key={activeKey}
            ref={reader}
            detailId={`${detailId}:archive:${activeKey}`}
            id={`${prefix}-reading`}
            information={active.content}
            label={`${active.label}阅读区`}
            positionKey={
              scope === undefined ? undefined : `${scope}:${activeKey}`
            }
            variant="desktop-information"
          />
          {paging.forward ? (
            <span className={styles.continuation} aria-hidden="true" />
          ) : null}
        </div>
        <footer
          className={styles.footer}
          data-overflow={paging.forward || paging.backward ? "" : undefined}
        >
          <div className={styles.paging}>
            <button
              type="button"
              aria-label="向左续读资料"
              title="向左续读"
              disabled={!paging.forward}
              aria-controls={`${prefix}-reading`}
              onClick={() => reader.current?.scrollByPage("forward")}
            >
              <Icon name="back" />
            </button>
            <span
              className={styles.progress}
              role="progressbar"
              aria-label="资料阅读进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={paging.progress}
            >
              <i style={{ transform: `scaleX(${paging.progress / 100})` }} />
            </span>
            <button
              type="button"
              aria-label="向右回读资料"
              title="向右回读"
              disabled={!paging.backward}
              aria-controls={`${prefix}-reading`}
              onClick={() => reader.current?.scrollByPage("backward")}
            >
              <Icon name="next" />
            </button>
          </div>
          {full ? null : (
            <button
              type="button"
              ref={expandButton}
              aria-label="展开资料阅读"
              title="展开阅读"
              onClick={() => {
                reader.current?.checkpoint();
                setExpanded(true);
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8 4H4v4M16 4h4v4M4 16v4h4M20 16v4h-4M4 4l5 5M20 4l-5 5M4 20l5-5M20 20l-5-5" />
              </svg>
            </button>
          )}
        </footer>
      </div>
    );
  };
  return (
    <aside
      className={styles.archive}
      ref={root}
      aria-label={label}
      data-desktop-detail-information=""
    >
      {expanded ? (
        <div className={styles.placeholder} aria-hidden="true" />
      ) : (
        frame(false)
      )}
      {expanded ? (
        <AuthorDialog
          className={styles.expandedDialog}
          title="资料阅读"
          navigationRef={dialog}
          onClose={() => {
            reader.current?.checkpoint();
            setExpanded(false);
          }}
        >
          {frame(true)}
        </AuthorDialog>
      ) : null}
    </aside>
  );
});
