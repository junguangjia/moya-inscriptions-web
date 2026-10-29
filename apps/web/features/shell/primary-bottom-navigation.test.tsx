import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  canArmPrimaryNavigationPointer,
  commitPrimaryNavigationDragRelease,
  createPrimaryNavigationEntryElements,
  hasPrimaryNavigationHorizontalDragIntent,
  PRIMARY_NAVIGATION_DRAG_THRESHOLD_PX,
  PrimaryBottomNavigation,
  resolvePrimaryNavigationBubbleIndex,
  resolvePrimaryNavigationReleaseIndex,
} from "./primary-bottom-navigation";

import type { ReactElement } from "react";
import type { PresentationPlatform } from "./device-platform";
import type { PrimaryBottomNavigationProps } from "./primary-bottom-navigation";
import type { PrimaryDestination } from "./primary-shell";

const destinations = [
  {
    id: "home",
    icon: "home",
    label: "首页",
  },
  {
    id: "discussion",
    icon: "discussion",
    label: "讨论",
  },
  {
    id: "user",
    icon: "user",
    label: "用户",
  },
] as const satisfies readonly {
  readonly id: PrimaryDestination;
  readonly icon: string;
  readonly label: string;
}[];

const renderNavigation = (
  activeDestination: PrimaryDestination = "home",
  platform: PresentationPlatform = "pc",
) =>
  renderToStaticMarkup(
    <PrimaryBottomNavigation
      activeDestination={activeDestination}
      platform={platform}
      onDestinationChange={vi.fn()}
    />,
  );

interface NavigationButtonProps {
  readonly "data-primary-navigation-destination"?: PrimaryDestination;
  readonly onClick?: () => void;
}

const navigationButtons = (
  onDestinationChange: (destination: PrimaryDestination) => void,
) =>
  Children.toArray(
    createPrimaryNavigationEntryElements("home", onDestinationChange),
  ).filter(
    (child): child is ReactElement<NavigationButtonProps> =>
      isValidElement<NavigationButtonProps>(child) && child.type === "button",
  );

describe("PrimaryBottomNavigation", () => {
  it("renders exactly the ordered home, discussion and user destinations with text labels", () => {
    const markup = renderNavigation();

    expect(markup.match(/data-primary-navigation-destination=/g)).toHaveLength(
      destinations.length,
    );
    expect(markup).toContain(`data-item-count="${destinations.length}"`);

    let lastIndex = -1;
    for (const { id, icon, label } of destinations) {
      const itemIndex = markup.indexOf(
        `data-primary-navigation-destination="${id}"`,
      );
      expect(itemIndex).toBeGreaterThan(lastIndex);
      lastIndex = itemIndex;
      expect(markup).toContain(`aria-label="${label}"`);
      expect(markup).toContain(`data-icon="${icon}"`);
      expect(markup).toContain(`>${label}</span>`);
    }

    expect(markup).not.toMatch(
      /data-primary-navigation-destination="(?:upload|profile|inscriptions|calligraphy)"|上传|个人中心/i,
    );
  });

  it.each(destinations)(
    "derives the controlled $id selection and active index",
    ({ id }) => {
      const activeIndex = destinations.findIndex(
        (candidate) => candidate.id === id,
      );
      const markup = renderNavigation(id);

      expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
      expect(markup).toContain(`data-active-index="${activeIndex}"`);
      expect(markup).toContain(
        `--primary-navigation-bubble-index:${activeIndex}`,
      );
      for (const { id: candidate } of destinations) {
        expect(markup).toContain(
          `data-primary-navigation-destination="${candidate}" data-selected="${
            candidate === id ? "true" : "false"
          }"`,
        );
      }
    },
  );

  it.each(["phone", "tablet", "pc"] as const)(
    "preserves the %s presentation platform identity",
    (platform) => {
      expect(renderNavigation("home", platform)).toContain(
        `data-platform="${platform}"`,
      );
    },
  );

  it.each(destinations)("commits one $id click exactly once", ({ id }) => {
    const onDestinationChange = vi.fn();
    const button = navigationButtons(onDestinationChange).find(
      (candidate) =>
        candidate.props["data-primary-navigation-destination"] === id,
    );

    expect(button).toBeDefined();
    button?.props.onClick?.();
    expect(onDestinationChange).toHaveBeenCalledOnce();
    expect(onDestinationChange).toHaveBeenCalledWith(id);
  });

  it("uses a thin feature-local contract without high-level navigation output", () => {
    const markup = renderNavigation();

    expectTypeOf<keyof PrimaryBottomNavigationProps>().toEqualTypeOf<
      | "activeDestination"
      | "desktop"
      | "onSettingsIntent"
      | "navigationAction"
      | "minimized"
      | "onDestinationChange"
      | "onExpand"
      | "platform"
    >();
    expect(markup).toContain("yoyi-functional-glass");
    expect(markup).toContain("yoyi-navigation-entry");
    expect(markup).toContain("data-primary-navigation-bubble");
    expect(markup).not.toContain("yoyi-mobile-bottom-navigation");
    expect(markup).not.toContain("yoyi-responsive-navigation");
    expect(markup).not.toContain("yoyi-desktop-navigation");
    expect(markup).not.toContain("data-primary-pager");
  });

  it("composes one optional sibling action without creating a fourth destination", () => {
    const markup = renderToStaticMarkup(
      <PrimaryBottomNavigation
        activeDestination="home"
        navigationAction={<button data-search-test="">搜索</button>}
        onDestinationChange={vi.fn()}
        platform="phone"
      />,
    );
    expect(markup.match(/data-primary-navigation-dock=/g)).toHaveLength(1);
    expect(markup.match(/data-primary-navigation-destination=/g)).toHaveLength(
      3,
    );
    expect(markup.match(/data-primary-navigation-action=/g)).toHaveLength(1);
    expect(markup.indexOf("data-search-test")).toBeGreaterThan(
      markup.indexOf("</nav>"),
    );
    expect(renderNavigation()).not.toContain("data-primary-navigation-action");
  });

  it("starts drag only beyond the strict horizontal intent threshold", () => {
    expect(
      hasPrimaryNavigationHorizontalDragIntent(
        PRIMARY_NAVIGATION_DRAG_THRESHOLD_PX,
        0,
      ),
    ).toBe(false);
    expect(
      hasPrimaryNavigationHorizontalDragIntent(
        PRIMARY_NAVIGATION_DRAG_THRESHOLD_PX + 1,
        PRIMARY_NAVIGATION_DRAG_THRESHOLD_PX,
      ),
    ).toBe(true);
    expect(hasPrimaryNavigationHorizontalDragIntent(20, 20)).toBe(false);
    expect(hasPrimaryNavigationHorizontalDragIntent(9, 12)).toBe(false);
  });

  it("arms primary touch independently of mouse-only button semantics", () => {
    expect(canArmPrimaryNavigationPointer(true, "touch", -1)).toBe(true);
    expect(canArmPrimaryNavigationPointer(true, "touch", 0)).toBe(true);
    expect(canArmPrimaryNavigationPointer(true, "pen", -1)).toBe(true);
    expect(canArmPrimaryNavigationPointer(true, "mouse", 0)).toBe(true);
    expect(canArmPrimaryNavigationPointer(true, "mouse", 2)).toBe(false);
    expect(canArmPrimaryNavigationPointer(false, "touch", 0)).toBe(false);
  });

  it("uses inline icons and real text without raster labels or masks", () => {
    const markup = renderNavigation();
    for (const { icon } of destinations) {
      expect(markup).toContain(
        `data-source-asset="packages/ui/src/assets/icons/${icon}.svg"`,
      );
    }
    expect(markup.match(/data-primary-navigation-text-label=/g)).toHaveLength(
      3,
    );
    expect(markup).toContain("data-primary-navigation-inline-icon");
    expect(markup).not.toMatch(/<image|<mask|\.png|yoyi-fixed-label/);
  });

  it("renders only the active icon as an inert 44px minimized control", () => {
    const markup = renderToStaticMarkup(
      <PrimaryBottomNavigation
        activeDestination="discussion"
        minimized
        onDestinationChange={vi.fn()}
        onExpand={vi.fn()}
        platform="phone"
      />,
    );

    expect(markup).toContain('data-minimized="true"');
    expect(markup).toContain('data-selected="true"');
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("derives continuous clamped bubble preview from rendered entry centers", () => {
    const entryCenters = [100, 220, 400];

    expect(resolvePrimaryNavigationBubbleIndex(entryCenters, 0, -200)).toBe(0);
    expect(resolvePrimaryNavigationBubbleIndex(entryCenters, 0, 60)).toBe(0.5);
    expect(resolvePrimaryNavigationBubbleIndex(entryCenters, 1, 90)).toBe(1.5);
    expect(resolvePrimaryNavigationBubbleIndex(entryCenters, 1, 500)).toBe(2);
  });

  it("resolves release to the nearest real entry without a hard-coded count", () => {
    expect(
      resolvePrimaryNavigationReleaseIndex(0.49, destinations.length),
    ).toBe(0);
    expect(resolvePrimaryNavigationReleaseIndex(0.5, destinations.length)).toBe(
      1,
    );
    expect(resolvePrimaryNavigationReleaseIndex(20, destinations.length)).toBe(
      destinations.length - 1,
    );
  });

  it("commits a different release destination exactly once and skips current", () => {
    const onDestinationChange = vi.fn();

    expect(
      commitPrimaryNavigationDragRelease("home", 1, onDestinationChange),
    ).toBe("discussion");
    expect(onDestinationChange).toHaveBeenCalledOnce();
    expect(onDestinationChange).toHaveBeenCalledWith("discussion");

    onDestinationChange.mockClear();
    expect(
      commitPrimaryNavigationDragRelease("home", 0.4, onDestinationChange),
    ).toBe("home");
    expect(onDestinationChange).not.toHaveBeenCalled();
  });
});
