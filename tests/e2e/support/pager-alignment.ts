import { expect } from "@playwright/test";
import type { Locator } from "@playwright/test";

/** Observe the same geometry on animation frames without tracing every poll. */
export const expectPanelAlignment = async (
  pager: Locator,
  selector: string,
  options: {
    gap?: number;
    fraction?: boolean;
    idle?: boolean;
    frames?: number;
    strict?: boolean;
  } = {},
) => {
  const result = await pager.evaluate(
    async (node, input) => {
      const deadline = performance.now() + 10_000;
      let consecutive = 0;
      let gap = Infinity;
      while (performance.now() < deadline) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        const panel = node.querySelector<HTMLElement>(input.selector);
        if (!panel) throw new Error(`Missing pager panel: ${input.selector}`);
        gap = Math.abs(
          panel.getBoundingClientRect().left -
            node.getBoundingClientRect().left,
        );
        if (input.fraction) gap /= node.clientWidth;
        const aligned =
          (input.strict ? gap < input.gap : gap <= input.gap) &&
          (!input.idle ||
            (node as HTMLElement).dataset.horizontalPagerScrolling === "false");
        consecutive = aligned ? consecutive + 1 : 0;
        if (consecutive >= input.frames) return { aligned: true, gap };
      }
      return { aligned: false, gap };
    },
    {
      selector,
      gap: options.gap ?? 2,
      fraction: options.fraction ?? false,
      idle: options.idle ?? false,
      frames: options.frames ?? 1,
      strict: options.strict ?? false,
    },
  );
  expect(result, `Pager alignment for ${selector}`).toMatchObject({
    aligned: true,
  });
};
