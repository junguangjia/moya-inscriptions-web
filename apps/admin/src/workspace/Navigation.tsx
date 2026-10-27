"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Link,
  Logout,
  useAuth,
  useNav,
  usePreferences,
  useTheme,
} from "@payloadcms/ui";
import { AdminIcon } from "../branding/Brand";
import { excludeOwnerAnalyticsDevice } from "../analytics/device";
import { UiIcon } from "./Icon";
import { currentWorkspace, workspacePages, workspaces } from "./routes";

export const WorkspaceNavigation = ({
  developmentAgentsEnabled = false,
}: {
  readonly developmentAgentsEnabled?: boolean;
}) => {
  const { user } = useAuth();
  const { hydrated, navOpen, navRef, shouldAnimate, setNavOpen } = useNav();
  const { theme, setTheme } = useTheme();
  const { getPreference } = usePreferences();
  const pathname = usePathname();
  const params = useSearchParams();
  const active = currentWorkspace(pathname, params);
  useEffect(() => {
    if (!hydrated) return;
    if (!window.matchMedia("(min-width: 1025px)").matches) return;
    let current = true;
    // Wait for Payload's initial preference read; it otherwise races this default.
    const fallback = window.setTimeout(() => {
      if (current) setNavOpen(true);
    }, 750);
    void getPreference("nav")
      .catch(() => undefined)
      .then(() => {
        window.clearTimeout(fallback);
        if (current) setNavOpen(true);
      });
    return () => {
      current = false;
      window.clearTimeout(fallback);
    };
  }, [hydrated, getPreference, setNavOpen]);
  useEffect(() => {
    if (user?.collection !== "users" || user.role !== "owner") return;
    const controller = new AbortController();
    void excludeOwnerAnalyticsDevice(controller.signal);
    return () => controller.abort();
  }, [user?.collection, user?.role]);
  if (user?.collection !== "users" || user.role !== "owner") return null;
  const closeOnMobile = () => {
    if (window.matchMedia("(max-width: 1024px)").matches) setNavOpen(false);
  };
  return (
    <aside
      className={[
        "nav",
        "archive-nav",
        navOpen && "nav--nav-open",
        hydrated && "nav--nav-hydrated",
        shouldAnimate && "nav--nav-animate",
      ]
        .filter(Boolean)
        .join(" ")}
      inert={!navOpen || undefined}
      aria-label="管理后台导航"
      data-has-workspace-bar={active !== null && active.workspace.id !== "home"}
    >
      <div className="nav__scroll" ref={navRef}>
        <Link
          className="archive-nav__brand"
          href="/admin"
          prefetch={false}
          onClick={closeOnMobile}
          aria-label="由于艺管理后台工作台"
        >
          <AdminIcon />
          <span>
            由于艺<span className="archive-nav__caption">管理后台</span>
          </span>
        </Link>
        <nav className="nav__wrap archive-nav__links" aria-label="工作区">
          {workspaces.map((workspace) => (
            <Link
              key={workspace.id}
              href={
                (
                  workspacePages(workspace, developmentAgentsEnabled)[0] ??
                  workspace.pages[0]
                ).href
              }
              prefetch={false}
              onClick={closeOnMobile}
              className="archive-nav__link"
              data-workspace={workspace.id}
              aria-current={
                active?.workspace.id === workspace.id ? "page" : undefined
              }
            >
              <UiIcon name={workspace.icon} size="sm" />
              <span>{workspace.label}</span>
              {active?.workspace.id === workspace.id ? (
                <span aria-hidden="true" className="archive-nav__mark" />
              ) : null}
            </Link>
          ))}
        </nav>
        <div className="archive-nav__footer">
          <Link
            href="/admin/account"
            prefetch={false}
            className="archive-nav__account"
            onClick={closeOnMobile}
          >
            <UiIcon name="user" size="sm" />
            <span>个人账号</span>
          </Link>
          <div className="archive-nav__controls">
            <button
              type="button"
              className="archive-icon-button"
              aria-label={theme === "dark" ? "切换浅色界面" : "切换深色界面"}
              title={theme === "dark" ? "切换浅色界面" : "切换深色界面"}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              <UiIcon
                name={theme === "dark" ? "theme-light" : "theme-dark"}
                size="sm"
              />
            </button>
            <Logout />
          </div>
        </div>
      </div>
    </aside>
  );
};

/** Flat sibling navigation also covers Payload collection create/edit/version views. */
export const WorkspaceTabs = ({
  developmentAgentsEnabled = false,
}: {
  readonly developmentAgentsEnabled?: boolean;
}) => {
  const { user } = useAuth();
  const { navOpen } = useNav();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = currentWorkspace(pathname, params);
  const activeLink = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    activeLink.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname, params]);
  if (
    user?.collection !== "users" ||
    user.role !== "owner" ||
    !current ||
    current.workspace.id === "home"
  )
    return null;
  const pages = workspacePages(current.workspace, developmentAgentsEnabled);
  return (
    <div
      className="archive-workspace-bar"
      data-current-workspace={current.workspace.id}
      data-nav-open={navOpen}
    >
      <span className="archive-workspace-name">
        <UiIcon name={current.workspace.icon} size="sm" />
        {current.workspace.label}
      </span>
      <nav
        className="archive-workspace-tabs"
        aria-label={`${current.workspace.label}页面`}
      >
        {pages.map((page) =>
          pathname === "/admin/community-moderation/content" &&
          page.href.split("?")[0] === pathname ? (
            <a
              href={page.href}
              key={page.href}
              className="archive-workspace-tab"
              aria-current={
                current.page.href === page.href ? "page" : undefined
              }
              ref={current.page.href === page.href ? activeLink : undefined}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                window.history.pushState(null, "", page.href);
              }}
            >
              {page.label}
            </a>
          ) : (
            <Link
              href={page.href}
              key={page.href}
              prefetch={false}
              className="archive-workspace-tab"
              aria-current={
                current.page.href === page.href ? "page" : undefined
              }
              ref={current.page.href === page.href ? activeLink : undefined}
            >
              {page.label}
            </Link>
          ),
        )}
      </nav>
    </div>
  );
};
