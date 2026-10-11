"use client";

import { Icon } from "@moya/ui";
import { useLayoutEffect } from "react";

import detailStyles from "../../../detail/catalog-detail.module.css";
import hostStyles from "../../publishing-entry.module.css";
import styles from "./editor.module.css";

import type { ProductShellEditorOverlayControls } from "../../../product-shell/product-shell";
import type { ReactNode } from "react";

/** Whether the return bar's Back held focus when a state change replaced the bar. */
const backFocus = new WeakMap<ProductShellEditorOverlayControls, true>();

export const ReturnBar = ({
  controls,
  title,
  status,
  actions,
  inert = false,
}: {
  readonly controls: ProductShellEditorOverlayControls;
  readonly title: string;
  readonly status?: ReactNode;
  readonly actions?: ReactNode;
  readonly inert?: boolean;
}) => {
  // Loading, the workspace and the unavailable state each render their own
  // bar: a focused Back stays focused across the swap.
  useLayoutEffect(() => {
    const button = controls.backButtonRef.current;
    const active = document.activeElement;
    if (
      backFocus.has(controls) &&
      button !== null &&
      (active === null || active === document.body)
    )
      button.focus({ preventScroll: true });
    backFocus.delete(controls);
    return () => {
      if (button !== null && document.activeElement === button)
        backFocus.set(controls, true);
    };
  }, [controls]);
  return (
    <header
      className={`${detailStyles.detailHeader} ${hostStyles.bar} ${styles.bar}`}
      data-editor-bar=""
      inert={inert}
    >
      <button
        ref={controls.backButtonRef}
        aria-label="返回"
        onClick={controls.close}
        type="button"
      >
        <Icon aria-hidden="true" name="back" />
      </button>
      <div className={styles.barTitle}>
        <strong>{title}</strong>
        {status}
      </div>
      <div className={styles.barActions}>
        {actions ?? <span aria-hidden="true" className={hostStyles.balance} />}
      </div>
    </header>
  );
};
