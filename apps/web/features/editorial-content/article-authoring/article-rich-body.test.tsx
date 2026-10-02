// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArticleRichBody } from "./article-rich-body";
import type { ArticleDocument } from "@moya/contracts";

describe("r4 lightweight reader parity", () => {
  it("reopens a responsive image width and wrap layout without changing its source or crop", () => {
    const document: ArticleDocument = {
      format: "blocknote",
      version: 1,
      references: {
        source: { type: "managed", itemId: `media-item-${"1".repeat(32)}` },
      },
      galleries: {},
      blocks: [
        {
          id: "image",
          type: "managedImage",
          props: {
            refId: "source",
            caption: "范围",
            alt: "合成",
            displayWidth: 0.5,
            cropX: 0.25,
            cropY: 0.25,
            cropWidth: 0.5,
            cropHeight: 0.5,
          },
          children: [],
        },
        {
          id: "text",
          type: "paragraph",
          props: {},
          content: [{ type: "text", text: "图片旁的文字", styles: {} }],
          children: [],
        },
      ],
    };
    const crops: unknown[] = [];
    const markup = renderToStaticMarkup(
      <ArticleRichBody
        document={document}
        renderMedia={(_reference, alt, crop) => {
          crops.push(crop);
          return <img src="/synthetic/source" alt={alt} />;
        }}
        renderCatalog={() => null}
      />,
    );
    const mount = window.document.createElement("div");
    mount.innerHTML = markup;
    expect(mount.querySelector("figure")?.style.width).toBe("50%");
    expect(mount.querySelector("figure")?.dataset.articleImageWrap).toBe(
      "true",
    );
    expect(mount.querySelector("img")?.getAttribute("src")).toBe(
      "/synthetic/source",
    );
    expect(crops).toEqual([{ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }]);
    expect(mount.querySelector("p")?.textContent).toBe("图片旁的文字");
  });
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
          props: { textAlignment: "justify", lineSpacing: "relaxed" },
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
                    backgroundColor: "red",
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
    expect(
      mount.querySelector('[data-article-background-color="red"]')?.textContent,
    ).toBe("繁體𠮷");
    expect(mount.querySelector("p")?.dataset.articleTextAlignment).toBe(
      "justify",
    );
    expect(mount.querySelector("p")?.dataset.articleLineSpacing).toBe(
      "relaxed",
    );
    expect(mount.querySelector(".bn-editor")).toBeNull();
  });
});
