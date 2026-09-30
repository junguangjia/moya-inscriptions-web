import {
  useEffect,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import { cx } from "../utils.js";
import { Icon, YoyiLogo } from "./brand.js";

export type SpinnerProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  label?: string;
  size?: "sm" | "md" | "lg";
};

export function Spinner({
  label = "加载中",
  size = "md",
  className,
  ...props
}: SpinnerProps) {
  return (
    <span
      {...props}
      aria-label={label}
      className={cx("yoyi-spinner", `yoyi-spinner--${size}`, className)}
      data-yoyi-ui="spinner"
      role="status"
    >
      <Icon name="loading" />
    </span>
  );
}

type StateProps = HTMLAttributes<HTMLDivElement> & {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
};

export type EmptyStateProps = StateProps;

export function EmptyState({
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      {...props}
      className={cx("yoyi-state", "yoyi-state--empty", className)}
      data-yoyi-ui="empty-state"
    >
      <Icon label="空状态" name="empty" size="lg" />
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action ? <div className="yoyi-state__action">{action}</div> : null}
    </div>
  );
}

export type ErrorStateProps = StateProps & {
  live?: "polite" | "assertive";
};

export function ErrorState({
  title,
  description,
  action,
  live = "polite",
  className,
  ...props
}: ErrorStateProps) {
  return (
    <div
      {...props}
      aria-live={live}
      className={cx("yoyi-state", "yoyi-state--error", className)}
      data-yoyi-ui="error-state"
      role="alert"
    >
      <Icon label="错误" name="error" size="lg" />
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action ? <div className="yoyi-state__action">{action}</div> : null}
    </div>
  );
}

export type LoadingScreenProps = HTMLAttributes<HTMLDivElement> & {
  active?: boolean;
  delay?: number;
  label?: string;
};

export function LoadingScreen({
  active = true,
  delay = 160,
  label = "由于艺正在加载",
  className,
  ...props
}: LoadingScreenProps) {
  const [visible, setVisible] = useState(active && delay <= 0);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }

    if (delay <= 0) {
      setVisible(true);
      return;
    }

    setVisible(false);
    const timer = window.setTimeout(() => setVisible(true), delay);
    return () => window.clearTimeout(timer);
  }, [active, delay]);

  if (!active || !visible) {
    return null;
  }

  return (
    <div
      {...props}
      aria-live="polite"
      aria-label={label}
      className={cx("yoyi-loading-screen", className)}
      data-yoyi-ui="loading-screen"
      role="status"
    >
      <div className="yoyi-loading-screen__brand">
        <YoyiLogo />
        <p className="yoyi-loading-screen__motto" lang="zh-CN">
          志于道，据于德，依于仁，游于艺
        </p>
      </div>
      <span className="yoyi-visually-hidden">{label}</span>
    </div>
  );
}
