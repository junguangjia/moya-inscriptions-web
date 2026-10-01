// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArticleRichBody } from "./article-rich-body";
import type { ArticleDocument } from "@moya/contracts";

describe("r4 lightweight reader parity", () => {
  it("renders nested underline, finite color, Unicode and links without editor runtime", () => {
    const document: ArticleDocument = {
      format: "blocknote",
      version: 1,
      references: {},
      galleries: {},
      blocks: [
        {
          id: "prose",
          type: "paragraph",
          props: {},
          children: [],
          content: [
            {
              type: "link",
              href: "https://example.invalid",
              content: [
                {
                  type: "text",
                  text: "繁體𠮷",
                  styles: {
                    bold: true,
                    italic: true,
                    underline: true,
                    textColor: "brown",
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <ArticleRichBody
        document={document}
        renderMedia={() => null}
        renderCatalog={() => null}
      />,
    );
    const mount = window.document.createElement("div");
    mount.innerHTML = markup;
    expect(
      mount.querySelector('[data-article-text-color="brown"] u strong em')
        ?.textContent,
    ).toBe("繁體𠮷");
    expect(mount.querySelector("a")?.getAttribute("rel")).toBe(
      "noreferrer noopener",
    );
    expect(mount.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.invalid",
    );
    expect(mount.querySelector(".bn-editor")).toBeNull();
  });
});
