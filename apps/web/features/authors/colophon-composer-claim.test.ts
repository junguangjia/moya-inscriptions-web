// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { Root } from "react-dom/client";
import {
  claimColophonComposer,
  currentColophonComposer,
  releaseColophonComposer,
  useColophonComposerClaimed,
} from "./colophon-composer-claim";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const Claimed = ({ name }: { readonly name: string }) =>
  createElement("span", {
    "data-key": name,
    "data-claimed": String(useColophonComposerClaimed(name)),
  });

const render = (...names: string[]) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      names.map((name) => createElement(Claimed, { key: name, name })),
    ),
  );
  return (name: string) =>
    container
      .querySelector(`[data-key="${name}"]`)!
      .getAttribute("data-claimed");
};

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  const held = currentColophonComposer();
  if (held !== null) releaseColophonComposer(held);
  document.body.replaceChildren();
});

describe("colophon composer claim", () => {
  it("holds no claim at first", () => {
    const claimed = render("a", "b");
    expect(currentColophonComposer()).toBeNull();
    expect(claimed("a")).toBe("false");
    expect(claimed("b")).toBe("false");
  });

  it("moves the claim to the second composer, releasing the first", () => {
    const claimed = render("a", "b");
    act(() => claimColophonComposer("a"));
    expect(claimed("a")).toBe("true");
    act(() => claimColophonComposer("b"));
    expect(claimed("a")).toBe("false");
    expect(claimed("b")).toBe("true");
    expect(currentColophonComposer()).toBe("b");
  });

  it("ignores a release by a composer that no longer holds the claim", () => {
    const claimed = render("a", "b");
    act(() => claimColophonComposer("a"));
    act(() => claimColophonComposer("b"));
    act(() => releaseColophonComposer("a"));
    expect(claimed("b")).toBe("true");
    act(() => releaseColophonComposer("b"));
    expect(claimed("b")).toBe("false");
    expect(currentColophonComposer()).toBeNull();
  });
});
