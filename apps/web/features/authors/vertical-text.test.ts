// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StudioName, UserIdentity } from "./user-identity";
import {
  colophonClipboardText,
  formatColophonTime,
  hanidecDigits,
  VerticalDigits,
  VerticalText,
  verticalQuotes,
} from "./vertical-text";

const render = (markup: string) => {
  const host = document.createElement("div");
  host.innerHTML = markup;
  return host;
};

describe("VerticalDigits", () => {
  it("sets runs of one or two digits upright side by side", () => {
    const host = render(
      renderToStaticMarkup(
        createElement(VerticalDigits, { text: "3分钟前，12则" }),
      ),
    );
    const spans = [...host.querySelectorAll("span")];
    expect(spans.map((span) => span.textContent)).toEqual(["3", "12"]);
    expect(
      spans.every((span) => span.getAttribute("aria-hidden") === null),
    ).toBe(true);
    expect(host.textContent).toBe("3分钟前，12则");
  });

  it("writes longer runs as Chinese numerals and keeps the digits for assistive technology", () => {
    const host = render(
      renderToStaticMarkup(createElement(VerticalDigits, { text: "128则" })),
    );
    const [numerals, original] = [...host.querySelectorAll("span")];
    expect(numerals?.getAttribute("aria-hidden")).toBe("true");
    expect(numerals?.textContent).toBe("一二八");
    expect(original?.getAttribute("aria-hidden")).toBeNull();
    expect(original?.textContent).toBe("128");
    expect(host.textContent).toBe("一二八128则");
  });

  it("keeps zeros digit by digit", () => {
    expect(hanidecDigits("2026")).toBe("二〇二六");
    expect(hanidecDigits("0105")).toBe("〇一〇五");
  });
});

describe("VerticalText", () => {
  const upright = (text: string) =>
    [
      ...render(
        renderToStaticMarkup(createElement(VerticalText, { text })),
      ).querySelectorAll("span"),
    ].map((span) => span.textContent);

  it("sets short digit runs upright and leaves longer ones as written", () => {
    expect(upright("10月9日临了2026年第3遍")).toEqual(["10", "9", "3"]);
    const host = render(
      renderToStaticMarkup(
        createElement(VerticalText, { text: "10月9日，2026年" }),
      ),
    );
    // Never rewritten into numerals.
    expect(host.textContent).toBe("10月9日，2026年");
  });

  it("leaves digits inside numbers, times and Latin words alone", () => {
    expect(upright("9:30 A4 3.5 v2 1/2")).toEqual([]);
  });

  it("shows curly quotes as corner brackets, apostrophes kept", () => {
    expect(verticalQuotes("“醴”字‘泉’")).toBe("「醴」字『泉』");
    expect(verticalQuotes("don’t")).toBe("don’t");
    expect(
      render(
        renderToStaticMarkup(createElement(VerticalText, { text: "“醴”" })),
      ).textContent,
    ).toBe("「醴」");
  });
});

describe("colophonClipboardText", () => {
  it("copies the selected digits, not their numerals", () => {
    const host = render(
      renderToStaticMarkup(createElement(VerticalDigits, { text: "128则" })),
    );
    document.body.append(host);
    const range = document.createRange();
    range.selectNodeContents(host);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(colophonClipboardText(selection)).toBe("128则");
    selection.removeAllRanges();
    host.remove();
  });
});

describe("formatColophonTime", () => {
  const now = new Date("2026-10-09T12:00:00.000Z");

  it("keeps the relative label for the first week, without spaces", () => {
    expect(formatColophonTime("2026-10-09T11:59:30.000Z", now)).toBe("刚刚");
    expect(formatColophonTime("2026-10-09T11:57:00.000Z", now)).toBe("3分钟前");
    expect(formatColophonTime("2026-10-09T07:00:00.000Z", now)).toBe("5小时前");
    expect(formatColophonTime("2026-10-07T12:00:00.000Z", now)).toBe("2天前");
  });

  it("writes older dates out, the year only when it is not the current one", () => {
    expect(formatColophonTime("2026-03-05T12:00:00.000Z", now)).toBe("3月5日");
    expect(formatColophonTime("2025-12-25T12:00:00.000Z", now)).toBe(
      "2025年12月25日",
    );
  });
});

describe("StudioName", () => {
  it("stands upright in a vertical plaque, one glyph per character", () => {
    const host = render(
      renderToStaticMarkup(
        createElement(StudioName, { value: "听雨A", orientation: "vertical" }),
      ),
    );
    const plaque = host.querySelector<HTMLElement>("[data-studio-name]");
    expect(plaque?.getAttribute("role")).toBe("img");
    expect(plaque?.getAttribute("aria-label")).toBe("斋号：听雨A");
    expect(plaque?.dataset.orientation).toBe("vertical");
    // 16px unit: 1.5 units wide, 3 + 1.25 units tall.
    expect(plaque?.style.width).toBe("1.5em");
    expect(plaque?.style.height).toBe("4.25em");
    expect(host.querySelector("svg")?.getAttribute("viewBox")).toBe(
      "0 0 24 68",
    );
    expect(host.querySelector("clipPath rect")?.getAttribute("rx")).toBe("12");
    expect(
      host.querySelector("pattern")?.getAttribute("patternTransform"),
    ).toBe("rotate(90)");
    const glyphs = [...host.querySelectorAll("text")];
    expect(glyphs.map((glyph) => glyph.textContent)).toEqual(["听", "雨", "A"]);
    expect(glyphs.map((glyph) => glyph.getAttribute("y"))).toEqual([
      "18",
      "34",
      "50",
    ]);
    expect(glyphs.every((glyph) => glyph.getAttribute("x") === "12")).toBe(
      true,
    );
    expect(
      host.querySelector("g[filter]")?.querySelectorAll("text"),
    ).toHaveLength(3);
  });

  it("keeps the horizontal plaque as it was", () => {
    const host = render(
      renderToStaticMarkup(createElement(StudioName, { value: "听雨轩" })),
    );
    const plaque = host.querySelector<HTMLElement>("[data-studio-name]");
    expect(plaque?.getAttribute("aria-label")).toBe("斋号：听雨轩");
    expect(plaque?.dataset.orientation).toBeUndefined();
    expect(plaque?.style.width).toBe("4.25em");
    expect(plaque?.style.height).toBe("");
    expect(host.querySelector("svg")?.getAttribute("viewBox")).toBe(
      "0 0 68 24",
    );
    expect(
      host.querySelector("pattern")?.hasAttribute("patternTransform"),
    ).toBe(false);
    expect(
      [...host.querySelectorAll("text")].map((t) => t.textContent),
    ).toEqual(["听雨轩"]);
  });

  it("renders nothing without a value", () => {
    expect(
      renderToStaticMarkup(
        createElement(StudioName, { value: "", orientation: "vertical" }),
      ),
    ).toBe("");
  });
});

describe("UserIdentity", () => {
  it("sets the nickname beside a vertical plaque", () => {
    const host = render(
      renderToStaticMarkup(
        createElement(UserIdentity, {
          name: "林间",
          studioName: "听雨轩",
          orientation: "vertical",
        }),
      ),
    );
    const identity = host.firstElementChild;
    expect(identity?.children).toHaveLength(2);
    expect(identity?.children[0]?.textContent).toBe("林间");
    expect(
      host.querySelector<HTMLElement>("[data-studio-name]")?.dataset
        .orientation,
    ).toBe("vertical");
  });

  it("keeps the horizontal identity unchanged by default", () => {
    const markup = renderToStaticMarkup(
      createElement(UserIdentity, { name: "林间", studioName: "听雨轩" }),
    );
    expect(markup).not.toContain("data-orientation");
    expect(render(markup).querySelectorAll("text")).toHaveLength(1);
  });
});
