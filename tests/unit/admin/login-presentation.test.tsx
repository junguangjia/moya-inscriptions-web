// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoginIntro } from "admin/login-intro";

afterEach(cleanup);

describe("native Admin authentication presentation", () => {
  it("adds an identifiable static heading without replacing any native authentication control", () => {
    const view = render(createElement(LoginIntro));
    expect(
      screen.getByRole("heading", { level: 1, name: "管理后台" }),
    ).toBeTruthy();
    expect(screen.getByText("由艺")).toBeTruthy();
    expect(screen.getByText("使用后台账号登录")).toBeTruthy();
    expect(
      view.container.querySelector("form,input,button,a,svg,img"),
    ).toBeNull();
  });

  it("keeps all CSS rules scoped to native auth/account pages or the new introduction", async () => {
    const require = createRequire(
      join(import.meta.dirname, "../../package.json"),
    );
    const css = await readFile(require.resolve("admin/login.css"), "utf8");
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    try {
      const sheet = style.sheet;
      expect(sheet).not.toBeNull();
      const selectors = (rules: CSSRuleList): string[] =>
        Array.from(rules).flatMap((rule) => {
          if ("cssRules" in rule)
            return selectors((rule as CSSGroupingRule).cssRules);
          return "selectorText" in rule
            ? [(rule as CSSStyleRule).selectorText]
            : [];
        });
      for (const selector of selectors(sheet!.cssRules)) {
        // Commas inside :is() and attribute values do not start a new selector.
        let depth = 0;
        let start = 0;
        for (let index = 0; index <= selector.length; index++) {
          if (selector[index] === "(" || selector[index] === "[") depth++;
          if (selector[index] === ")" || selector[index] === "]") depth--;
          if (
            (selector[index] === "," && depth === 0) ||
            index === selector.length
          ) {
            expect(selector.slice(start, index).trim()).toMatch(
              /^(?:\.archive-login-intro(?:\b|__)|\.(?:login|forgot-password|reset-password|account)\b|:is\(\.(?:login|forgot-password|reset-password|account)\b)/,
            );
            start = index + 1;
          }
        }
      }
      expect(css).not.toMatch(
        /(?:appearance|display|visibility)\s*:\s*(?:none|hidden)|overflow(?:-y)?\s*:\s*hidden|outline\s*:\s*(?:none|0)\b/,
      );
    } finally {
      style.remove();
    }
  });
});
