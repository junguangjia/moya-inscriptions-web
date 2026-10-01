import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";

import type { ThemePreference } from "@moya/design-tokens";

import type { NavigationItem } from "../types.js";
import { cx } from "../utils.js";
import { FixedLabelMark, Icon, YoyiLogo } from "./brand.js";
import { IconButton, type IconButtonProps, SearchInput } from "./primitives.js";

type NavigationItemsProps = {
  items: NavigationItem[];
  activeId?: string | undefined;
  onNavigate?: ((item: NavigationItem) => void) | undefined;
};

function NavigationEntry({
  item,
  active,
  onActivate,
  onNavigate,
}: {
  item: NavigationItem;
  active: boolean;
  onActivate?: ((item: NavigationItem) => boolean) | undefined;
  onNavigate?: ((item: NavigationItem) => void) | undefined;
}) {
  const content = (
    <>
      {item.icon ? (
        typeof item.icon === "string" ? (
          <Icon name={item.icon as import("../assets.js").IconName} />
        ) : (
          item.icon
        )
      ) : null}
      {item.labelMark ? (
        <FixedLabelMark decorative label={item.label} name={item.labelMark} />
      ) : (
        <span>{item.label}</span>
      )}
    </>
  );
  const shared = {
    "aria-label": item.label,
    "aria-current": active ? ("page" as const) : undefined,
    className: cx("yoyi-navigation-entry", active && "is-active"),
  };

  if (item.href) {
    return (
      <a
        {...shared}
        aria-disabled={item.disabled || undefined}
        href={item.disabled ? undefined : item.href}
        onClick={(event) => {
          if (item.disabled) {
            event.preventDefault();
            return;
          }
          if (onActivate?.(item)) {
            event.preventDefault();
            return;
          }
          onNavigate?.(item);
        }}
        tabIndex={item.disabled ? -1 : undefined}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      {...shared}
      disabled={item.disabled}
      onClick={() => {
        if (!onActivate?.(item)) {
          onNavigate?.(item);
        }
      }}
      type="button"
    >
      {content}
    </button>
  );
}

const themeOrder: ThemePreference[] = ["system", "light", "dark"];
const defaultThemeLabels: Record<ThemePreference, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

export type ThemeCycleButtonProps = Omit<
  IconButtonProps,
  "icon" | "label" | "onClick" | "value"
> & {
  value: ThemePreference;
  onValueChange: (value: ThemePreference) => void;
  labels?: Partial<Record<ThemePreference, string>>;
};

export function ThemeCycleButton({
  value,
  onValueChange,
  labels,
  ...props
}: ThemeCycleButtonProps) {
  const currentIndex = themeOrder.indexOf(value);
  const nextValue =
    themeOrder[(currentIndex + 1) % themeOrder.length] ?? "system";
  const resolvedLabels = { ...defaultThemeLabels, ...labels };

  return (
    <IconButton
      {...props}
      data-theme-preference={value}
      icon={<Icon name="theme" />}
      label={`当前主题：${resolvedLabels[value]}，切换为${resolvedLabels[nextValue]}`}
      onClick={() => onValueChange(nextValue)}
    />
  );
}

export type DesktopBrandHeaderProps = HTMLAttributes<HTMLElement> & {
  brandLabel?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
};

export function DesktopBrandHeader({
  brandLabel = "由于艺",
  subtitle,
  actions,
  className,
  ...props
}: DesktopBrandHeaderProps) {
  return (
    <header
      {...props}
      className={cx("yoyi-desktop-brand-header", className)}
      data-yoyi-ui="desktop-brand-header"
    >
      <div className="yoyi-desktop-brand-header__brand">
        <YoyiLogo label={brandLabel} />
        {subtitle ? <span>{subtitle}</span> : null}
      </div>
      {actions ? (
        <div className="yoyi-desktop-brand-header__actions">{actions}</div>
      ) : null}
    </header>
  );
}

export type DesktopTopNavigationProps = HTMLAttributes<HTMLElement> &
  NavigationItemsProps & {
    label?: string | undefined;
    brandLabel?: string | undefined;
    brandHref?: string | undefined;
    searchLabel?: string | undefined;
    onSearch?: (() => void) | undefined;
  };

export function DesktopTopNavigation({
  items,
  activeId,
  onNavigate,
  label = "主导航",
  brandLabel = "由于艺",
  brandHref,
  searchLabel = "搜索",
  onSearch,
  className,
  ...props
}: DesktopTopNavigationProps) {
  return (
    <nav
      {...props}
      aria-label={label}
      className={cx("yoyi-desktop-navigation", className)}
      data-yoyi-ui="desktop-navigation"
    >
      {brandHref ? (
        <a
          aria-label={brandLabel}
          className="yoyi-desktop-navigation__brand"
          href={brandHref}
        >
          <YoyiLogo aria-hidden label={brandLabel} />
        </a>
      ) : (
        <span className="yoyi-desktop-navigation__brand">
          <YoyiLogo label={brandLabel} />
        </span>
      )}
      <div className="yoyi-desktop-navigation__items">
        {items.map((item) => (
          <NavigationEntry
            active={item.id === activeId}
            item={item}
            key={item.id}
            onNavigate={onNavigate}
          />
        ))}
      </div>
      <IconButton
        icon={<Icon name="search" />}
        label={searchLabel}
        onClick={onSearch}
      />
    </nav>
  );
}

export type MobileBottomNavigationProps = HTMLAttributes<HTMLElement> &
  NavigationItemsProps & {
    label?: string | undefined;
    minimizeBehavior?: "never" | "on-scroll-down" | undefined;
    scrollContainerRef?: RefObject<HTMLElement | null> | undefined;
  };

export function MobileBottomNavigation({
  items,
  activeId,
  onNavigate,
  label = "主导航",
  minimizeBehavior = "never",
  scrollContainerRef,
  className,
  ...props
}: MobileBottomNavigationProps) {
  const [minimized, setMinimized] = useState(false);
  const minimizedRef = useRef(false);

  useEffect(() => {
    minimizedRef.current = minimized;
  }, [minimized]);

  useEffect(() => {
    if (minimizeBehavior === "never") {
      setMinimized(false);
      return undefined;
    }

    const scrollContainer = scrollContainerRef?.current;
    const eventTarget: HTMLElement | Window = scrollContainer ?? window;
    const readScrollTop = () =>
      scrollContainer
        ? scrollContainer.scrollTop
        : Math.max(window.scrollY, document.documentElement.scrollTop);
    let lastScrollTop = readScrollTop();
    let downwardTravel = 0;
    let upwardTravel = 0;

    const handleScroll = () => {
      const scrollTop = readScrollTop();
      const delta = scrollTop - lastScrollTop;
      lastScrollTop = scrollTop;

      if (scrollTop <= 8) {
        downwardTravel = 0;
        upwardTravel = 0;
        setMinimized(false);
        return;
      }

      if (delta > 0) {
        downwardTravel += delta;
        upwardTravel = 0;
        if (!minimizedRef.current && downwardTravel >= 12) {
          downwardTravel = 0;
          setMinimized(true);
        }
      } else if (delta < 0) {
        upwardTravel -= delta;
        downwardTravel = 0;
        if (minimizedRef.current && upwardTravel >= 8) {
          upwardTravel = 0;
          setMinimized(false);
        }
      }
    };

    eventTarget.addEventListener("scroll", handleScroll, { passive: true });
    return () => eventTarget.removeEventListener("scroll", handleScroll);
  }, [minimizeBehavior, scrollContainerRef]);

  const handleActivate = (item: NavigationItem) => {
    if (minimized && item.id === activeId) {
      setMinimized(false);
      return true;
    }
    return false;
  };

  return (
    <nav
      {...props}
      aria-label={label}
      className={cx(
        "yoyi-mobile-bottom-navigation",
        "yoyi-functional-glass",
        minimized && "is-minimized",
        className,
      )}
      data-minimize-behavior={minimizeBehavior}
      data-minimized={minimized || undefined}
      data-yoyi-ui="mobile-bottom-navigation"
    >
      {items.map((item) => (
        <NavigationEntry
          active={item.id === activeId}
          item={item}
          key={item.id}
          onActivate={handleActivate}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}

export type ResponsiveNavigationProps = NavigationItemsProps & {
  mobileItems?: NavigationItem[];
  desktopLabel?: string | undefined;
  mobileLabel?: string | undefined;
  brandLabel?: string | undefined;
  brandHref?: string | undefined;
  searchLabel?: string | undefined;
  onSearch?: (() => void) | undefined;
  minimizeBehavior?: "never" | "on-scroll-down" | undefined;
  scrollContainerRef?: RefObject<HTMLElement | null> | undefined;
  className?: string | undefined;
};

export function ResponsiveNavigation({
  items,
  mobileItems = items,
  activeId,
  onNavigate,
  desktopLabel,
  mobileLabel,
  brandLabel,
  brandHref,
  searchLabel,
  onSearch,
  minimizeBehavior,
  scrollContainerRef,
  className,
}: ResponsiveNavigationProps) {
  return (
    <div
      className={cx("yoyi-responsive-navigation", className)}
      data-yoyi-ui="responsive-navigation"
    >
      <DesktopTopNavigation
        activeId={activeId}
        brandHref={brandHref}
        brandLabel={brandLabel}
        items={items}
        label={desktopLabel}
        onNavigate={onNavigate}
        onSearch={onSearch}
        searchLabel={searchLabel}
      />
      <MobileBottomNavigation
        activeId={activeId}
        items={mobileItems}
        label={mobileLabel}
        minimizeBehavior={minimizeBehavior}
        onNavigate={onNavigate}
        scrollContainerRef={scrollContainerRef}
      />
    </div>
  );
}

export type MobileTopBarProps = HTMLAttributes<HTMLElement> & {
  leading?: ReactNode;
  title?: ReactNode;
  actions?: ReactNode;
};

export function MobileTopBar({
  leading,
  title,
  actions,
  className,
  ...props
}: MobileTopBarProps) {
  return (
    <header
      {...props}
      className={cx("yoyi-mobile-top-bar", className)}
      data-yoyi-ui="mobile-top-bar"
    >
      <div>{leading}</div>
      <div className="yoyi-mobile-top-bar__title">{title}</div>
      <div>{actions}</div>
    </header>
  );
}

export type SearchHeaderProps = Omit<
  HTMLAttributes<HTMLElement>,
  "onChange" | "onSubmit"
> & {
  title?: ReactNode;
  query: string;
  onQueryChange: (query: string) => void;
  onSubmit?: (query: string) => void;
  searchLabel?: string;
  placeholder?: string;
};

export function SearchHeader({
  title,
  query,
  onQueryChange,
  onSubmit,
  searchLabel = "搜索",
  placeholder = "搜索碑刻、书帖或地点",
  className,
  ...props
}: SearchHeaderProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit?.(query);
  };

  return (
    <header
      {...props}
      className={cx("yoyi-search-header", className)}
      data-yoyi-ui="search-header"
    >
      {title ? <h1>{title}</h1> : null}
      <form onSubmit={handleSubmit} role="search">
        <SearchInput
          label={searchLabel}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          onClear={() => onQueryChange("")}
          placeholder={placeholder}
          value={query}
        />
      </form>
    </header>
  );
}
