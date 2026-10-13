import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, expectTypeOf, it } from "vitest";

import { PrimaryShell } from "./primary-shell";

import type { PresentationPlatform } from "./device-platform";
import type { PrimaryDestination, PrimaryShellProps } from "./primary-shell";

const destinations = [
  "home",
  "discussion",
  "user",
] as const satisfies readonly PrimaryDestination[];

const renderShell = (
  activeDestination: PrimaryDestination = "home",
  platform: PresentationPlatform = "pc",
) =>
  renderToStaticMarkup(
    <PrimaryShell
      activeDestination={activeDestination}
      platform={platform}
      home={<p>home content</p>}
      discussion={<p>discussion content</p>}
      user={<p>user content</p>}
    />,
  );

const destinationSectionTag = (
  markup: string,
  destination: PrimaryDestination,
) => {
  const tag = markup.match(
    new RegExp(
      `<section(?=[^>]*data-primary-destination="${destination}")[^>]*>`,
    ),
  )?.[0];

  expect(tag).toBeDefined();
  return tag ?? "";
};

describe("PrimaryShell", () => {
  it("represents exactly the three semantic destinations with distinguishable mounted content", () => {
    const markup = renderShell("user");

    expect(markup.match(/data-primary-destination=/g)).toHaveLength(3);
    for (const destination of destinations) {
      expect(markup).toContain(`data-primary-destination="${destination}"`);
      expect(markup).toContain(`${destination} content`);
    }
  });

  it.each(["home", "discussion"] as const)(
    "starts on %s without mounting 我, which loads the viewer's profile and images",
    (activeDestination) => {
      const markup = renderShell(activeDestination);

      expect(destinationSectionTag(markup, "user")).toContain(" hidden");
      expect(markup).not.toContain("user content");
      expect(markup).toContain("home content");
      expect(markup).toContain("discussion content");
    },
  );

  it.each(destinations)(
    "exposes only %s once every destination has been opened",
    (activeDestination) => {
      const markup = renderShell(activeDestination);

      expect(markup).toContain(
        `data-active-destination="${activeDestination}"`,
      );
      for (const destination of destinations) {
        const sectionTag = destinationSectionTag(markup, destination);
        const active = destination === activeDestination;

        expect(sectionTag).toContain(
          `data-active="${active ? "true" : "false"}"`,
        );
        expect(sectionTag.includes(" hidden")).toBe(!active);
        if (destination !== "user" || activeDestination === "user")
          expect(markup).toContain(`${destination} content`);
      }
    },
  );

  it.each([
    "phone",
    "tablet",
    "pc",
  ] as const satisfies readonly PresentationPlatform[])(
    "expresses the provided %s platform without resolving it",
    (platform) => {
      expect(renderShell("home", platform)).toContain(
        `data-platform="${platform}"`,
      );
    },
  );

  it("accepts only structural inputs and no Catalog source", () => {
    expectTypeOf<keyof PrimaryShellProps>().toEqualTypeOf<
      "activeDestination" | "platform" | "home" | "discussion" | "user"
    >();
  });

  it("renders without prototype browser globals", () => {
    expect("window" in globalThis).toBe(false);
    expect("document" in globalThis).toBe(false);
    expect(() => renderShell()).not.toThrow();
  });
});
