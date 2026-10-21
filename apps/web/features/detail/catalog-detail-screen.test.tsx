import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CatalogDetailScreen } from "./catalog-detail-screen";

import type { ReactNode } from "react";
import type { PresentationPlatform } from "../shell/device-platform";

const renderState = (
  state: Parameters<typeof CatalogDetailScreen>[0]["state"],
  commentSection?: ReactNode,
  platform: PresentationPlatform = "phone",
  orientation: "landscape" | "portrait" = "portrait",
) =>
  renderToStaticMarkup(
    <CatalogDetailScreen
      activeMediaIndex={0}
      backButtonRef={createRef<HTMLButtonElement>()}
      commentSection={commentSection}
      onActiveMediaIndexChange={vi.fn()}
      onBack={vi.fn()}
      onOpenViewer={vi.fn()}
      orientation={orientation}
      platform={platform}
      state={state}
    />,
  );

describe("CatalogDetailScreen", () => {
  it("mounts an injected comment section only for a loaded Detail", () => {
    const comments = <section data-comment-section="">comments</section>;
    expect(renderState({ state: "loading" }, comments)).not.toContain(
      "data-comment-section",
    );
    expect(
      renderState(
        {
          detail: {
            aliases: [],
            facts: [],
            id: "with-comments",
            kind: "inscription",
            media: [],
            sections: [],
            source: "qa",
            sourceCitations: [],
            title: "评论挂载测试",
          },
          state: "loaded",
        },
        comments,
      ),
    ).toContain("data-comment-section");
  });

  it("pages compact Detail content and stacks comments under wide compositions", () => {
    const state = {
      detail: {
        aliases: [],
        facts: [],
        id: "paged-comments",
        kind: "inscription" as const,
        media: [],
        sections: [],
        source: "qa" as const,
        sourceCitations: [],
        title: "分页评论测试",
      },
      state: "loaded" as const,
    };
    const comments = <section data-comment-section="">comments</section>;
    const phone = renderState(state, comments);
    const tabletLandscape = renderState(state, comments, "tablet", "landscape");
    const pc = renderState(state, comments, "pc", "landscape");

    expect(phone).toContain("data-detail-content-pager");
    expect(
      phone.indexOf('data-detail-content-panel="information"'),
    ).toBeLessThan(phone.indexOf('data-detail-content-panel="comments"'));
    expect(phone).toContain('data-detail-content-active-page="information"');
    expect(tabletLandscape).not.toContain("data-detail-content-pager");
    expect(tabletLandscape).toContain("data-detail-landscape-layout");
    expect(tabletLandscape).toContain("data-detail-landscape-media");
    expect(tabletLandscape).toContain("data-detail-landscape-comments");
    expect(tabletLandscape.indexOf("data-detail-landscape-media")).toBeLessThan(
      tabletLandscape.indexOf("data-detail-info-panel"),
    );
    expect(tabletLandscape.indexOf("data-detail-info-panel")).toBeLessThan(
      tabletLandscape.indexOf("data-detail-landscape-comments"),
    );
    expect(pc).not.toContain("data-detail-content-pager");
    expect(pc).toContain("data-comment-section");
    expect(pc).toContain("data-detail-landscape-layout");
    expect(pc.indexOf("data-detail-landscape-media")).toBeLessThan(
      pc.indexOf("data-detail-info-panel"),
    );
    expect(pc.indexOf("data-detail-info-panel")).toBeLessThan(
      pc.indexOf("data-detail-landscape-comments"),
    );
  });

  it("collapses the reading flow only where comments render", () => {
    const state = {
      detail: {
        aliases: [],
        facts: [],
        id: "reading-disclosure",
        kind: "inscription" as const,
        media: [],
        sections: [
          { key: "transcription" as const, text: "释文", title: "释文" },
        ],
        source: "qa" as const,
        sourceCitations: [],
        title: "详情折叠测试",
      },
      state: "loaded" as const,
    };
    const comments = <section data-comment-section="">comments</section>;

    for (const [platform, orientation] of [
      ["tablet", "landscape"],
      ["pc", "landscape"],
    ] as const) {
      const withComments = renderState(state, comments, platform, orientation);
      expect(withComments).toContain("data-detail-reading-disclosure");
      expect(withComments).toContain('data-detail-section="transcription"');

      const formal = renderState(state, undefined, platform, orientation);
      expect(formal).not.toContain("data-detail-reading-disclosure");
      expect(formal).not.toContain("data-detail-landscape-layout");
      expect(formal).toContain('data-detail-section="transcription"');
    }

    expect(renderState(state, comments)).not.toContain(
      "data-detail-reading-disclosure",
    );
  });

  it.each([
    ["not-found", "未找到这项资料"],
    ["unavailable", "资料服务当前不可用"],
    ["unexpected-error", "发生了未预期的错误"],
  ] as const)(
    "renders truthful %s state with Back and no Retry",
    (state, copy) => {
      const markup = renderState({ state });
      expect(markup).toContain(copy);
      expect(markup).toContain('aria-label="返回"');
      expect(markup).not.toContain("重试");
    },
  );

  it("renders approved Content V1 sections and citation scopes once in order", () => {
    const markup = renderState({
      detail: {
        aliases: ["别名"],
        facts: [
          { label: "撰文者", value: "撰文者甲" },
          { label: "书者", value: "书者乙" },
          { label: "书体", value: "楷书" },
        ],
        id: "complete-content",
        kind: "inscription",
        media: [],
        periodLabel: "唐",
        sections: [
          { key: "description", text: "简介正文", title: "简介" },
          {
            key: "transcription",
            text: "第一行释文\n第二行释文",
            title: "释文",
          },
          {
            key: "historicalContext",
            text: "历史背景正文",
            title: "历史背景",
          },
          {
            key: "scholarlyResearch",
            text: "学术研究正文",
            title: "学术研究",
          },
        ],
        source: "runtime",
        sourceCitations: [
          { label: "旧来源", scopeLabel: "整体资料" },
          {
            citation: "多范围引文",
            label: "分区来源",
            scopeLabel: "释文、历史背景",
          },
        ],
        summary: "标题摘要只出现一次",
        title: "完整内容",
      },
      state: "loaded",
    });

    expect(markup.match(/标题摘要只出现一次/gu)).toHaveLength(1);
    expect(markup).toContain("第一行释文\n第二行释文");
    expect(markup.match(/旧来源/gu)).toHaveLength(1);
    expect(markup).toContain("适用于：整体资料");
    expect(markup).toContain("适用于：释文、历史背景");
    const orderedSections = [
      'data-detail-section="description"',
      'data-detail-section="transcription"',
      'data-detail-section="historicalContext"',
      'data-detail-section="scholarlyResearch"',
      'data-detail-section="sources"',
    ];
    for (let index = 1; index < orderedSections.length; index += 1) {
      expect(markup.indexOf(orderedSections[index] ?? "")).toBeGreaterThan(
        markup.indexOf(orderedSections[index - 1] ?? ""),
      );
    }
  });

  it("renders the truthful sparse no-media state without absent sections", () => {
    const markup = renderState({
      detail: {
        aliases: [],
        facts: [],
        id: "no-media",
        kind: "inscription",
        media: [],
        sections: [],
        source: "qa",
        sourceCitations: [],
        title: "无图资料",
      },
      state: "loaded",
    });

    expect(markup).toContain('data-detail-media-state="missing"');
    expect(markup).toContain("暂无公开图像");
    expect(markup).not.toMatch(
      /简介|释文|历史背景|学术研究|transcription|Viewer|Gallery/u,
    );
  });
  it("marks a real content update as 已编辑 beside the first publication time", () => {
    const work = (overrides: Record<string, unknown>) =>
      renderState({
        detail: {
          aliases: [],
          authorId: `user-${"a".repeat(32)}`,
          authorName: "临帖人",
          available: true,
          canEdit: true,
          contentType: "work",
          facts: [],
          id: `work-${"b".repeat(32)}`,
          media: [],
          sections: [],
          source: "runtime",
          sourceCitations: [],
          title: "春日临帖",
          firstPublishedAt: "2026-09-10T08:00:00.000Z",
          editedAt: null,
          ...overrides,
        },
        state: "loaded",
      });

    const edited = work({ editedAt: "2026-09-12T08:00:00.000Z" });
    const publication = edited.slice(
      edited.indexOf("data-detail-publication"),
      edited.indexOf("</p>", edited.indexOf("data-detail-publication")),
    );
    expect(publication).toContain('dateTime="2026-09-10T08:00:00.000Z"');
    expect(publication).toContain("2026年9月");
    expect(publication).toContain("已编辑");

    const unedited = work({});
    expect(unedited).toContain("data-detail-publication");
    expect(unedited).not.toContain("已编辑");

    // Never publicly exposed: no time and no pending wording.
    const notYetPublic = work({
      firstPublishedAt: null,
      editedAt: null,
      visibility: "self",
    });
    expect(notYetPublic).not.toContain("data-detail-publication");
    expect(notYetPublic).not.toMatch(/审核|待发布|未发布|不可用/u);
  });

  it("names an untitled work only for assistive technology", () => {
    const markup = renderState({
      detail: {
        aliases: [],
        authorId: `user-${"a".repeat(32)}`,
        authorName: "临帖人",
        available: true,
        canEdit: false,
        contentType: "work",
        facts: [],
        id: `work-${"c".repeat(32)}`,
        media: [],
        sections: [{ key: "description", title: "正文", text: "只有正文" }],
        source: "runtime",
        sourceCitations: [],
        title: "",
      },
      state: "loaded",
    });
    // No visible title is invented; heading navigation still finds the work.
    expect(markup).not.toContain("data-detail-title");
    expect(markup).toMatch(
      /<h1 class="[^"]*visuallyHidden[^"]*" data-detail-untitled="">未命名作品<\/h1>/u,
    );
    // r4: author identity belongs to the injected actions above, not a duplicate in this body panel.
    expect(markup).not.toContain("临帖人");
    expect(markup).not.toContain("<h2>正文</h2>");
    expect(markup).toContain("只有正文");
  });

  it("presents a text-only work without a missing-image block in every composition", () => {
    const state = {
      detail: {
        aliases: [],
        authorId: `user-${"a".repeat(32)}`,
        authorName: "临帖人",
        available: true,
        canEdit: false,
        contentType: "work" as const,
        facts: [],
        id: `work-${"d".repeat(32)}`,
        media: [],
        sections: [
          {
            key: "description" as const,
            title: "正文",
            text: "只有文字的作品",
          },
        ],
        source: "runtime" as const,
        sourceCitations: [],
        title: "文字作品",
      },
      state: "loaded" as const,
    };
    const comments = <section data-comment-section="">comments</section>;
    for (const markup of [
      renderState(state),
      renderState(state, comments),
      renderState(state, comments, "tablet", "landscape"),
      renderState(state, comments, "pc", "landscape"),
      renderState(state, undefined, "pc", "landscape"),
    ]) {
      expect(markup).not.toContain("data-detail-media-state");
      expect(markup).not.toContain("暂无公开图像");
      expect(markup).not.toContain("data-detail-media-carousel");
      expect(markup).not.toContain("data-detail-paged-media");
      expect(markup).not.toContain("data-detail-landscape-media");
      // Without media the text is the work: never collapsed behind 详情.
      expect(markup).not.toContain("data-detail-reading-disclosure");
      expect(markup).toContain("只有文字的作品");
    }
    expect(renderState(state, comments, "pc", "landscape")).toContain(
      "data-detail-text-only",
    );
  });

  it("shows a work's authorship to every reader as its own section in every composition", () => {
    const work = (
      authorship?: import("./catalog-detail-presentation").DetailAuthorshipPresentation,
      media = true,
    ) => ({
      detail: {
        aliases: [],
        authorId: `user-${"a".repeat(32)}`,
        authorName: "临帖人",
        available: true,
        canEdit: false,
        contentType: "work" as const,
        facts: [],
        id: `work-${"f".repeat(32)}`,
        media: media
          ? [
              {
                id: `item-${"f".repeat(32)}`,
                src: "/still.jpg",
                alt: "作品",
                width: 400,
                height: 300,
              },
            ]
          : [],
        sections: [
          { key: "description" as const, title: "正文", text: "临帖一通" },
        ],
        source: "runtime" as const,
        sourceCitations: [],
        title: "春日临帖",
        ...(authorship === undefined ? {} : { authorship }),
      },
      state: "loaded" as const,
    });
    const copy = work({
      kind: "copy_practice",
      label: "临摹或练习",
      references: [
        { label: "参考作品", value: "兰亭序" },
        { label: "原作者", value: "王羲之" },
        { label: "来源", value: "碑帖拓本" },
      ],
    });
    const comments = <section data-comment-section="">comments</section>;
    for (const markup of [
      renderState(copy),
      renderState(copy, comments),
      renderState(copy, comments, "tablet", "landscape"),
      renderState(copy, comments, "pc", "landscape"),
      renderState(copy, undefined, "pc", "landscape"),
    ]) {
      expect(markup).toContain('data-detail-section="authorship"');
      expect(markup).toContain('data-detail-authorship="copy_practice"');
      expect(markup).toContain("<h2>作品性质</h2>");
      expect(markup).toContain("临摹或练习");
      for (const text of [
        "<dt>参考作品</dt><dd>兰亭序</dd>",
        "<dt>原作者</dt><dd>王羲之</dd>",
        "<dt>来源</dt><dd>碑帖拓本</dd>",
      ])
        expect(markup).toContain(text);
      // After the body, in the reading flow.
      expect(markup.indexOf("临帖一通")).toBeLessThan(
        markup.indexOf('data-detail-section="authorship"'),
      );
    }

    const original = renderState(
      work({ kind: "original", label: "原创", references: [] }, false),
      comments,
      "pc",
      "landscape",
    );
    expect(original).toContain('data-detail-authorship="original"');
    expect(original).toContain("原创");
    expect(original).not.toContain("data-detail-authorship-references");

    // A reading flow of authorship alone still renders.
    const onlyAuthorship = renderState({
      ...work({ kind: "original", label: "原创", references: [] }),
      detail: {
        ...work({ kind: "original", label: "原创", references: [] }).detail,
        sections: [],
      },
    });
    expect(onlyAuthorship).toContain('data-detail-section="authorship"');

    expect(renderState(work())).not.toContain("data-detail-authorship");
  });

  it("replaces media, actions and comments with a withdrawal notice", () => {
    const markup = renderToStaticMarkup(
      <CatalogDetailScreen
        activeMediaIndex={0}
        backButtonRef={createRef<HTMLButtonElement>()}
        commentSection={<section data-comment-section="">comments</section>}
        detailActions={<div data-test-actions="" />}
        onActiveMediaIndexChange={vi.fn()}
        onBack={vi.fn()}
        onOpenViewer={vi.fn()}
        orientation="portrait"
        platform="phone"
        state={{
          detail: {
            aliases: [],
            authorId: `user-${"a".repeat(32)}`,
            authorName: "临帖人",
            available: true,
            canEdit: true,
            contentType: "work",
            facts: [],
            id: `work-${"e".repeat(32)}`,
            media: [
              {
                id: `item-${"e".repeat(32)}`,
                src: "/still.jpg",
                alt: "作品",
                width: 400,
                height: 300,
              },
            ],
            sections: [],
            source: "runtime",
            sourceCitations: [],
            title: "春日临帖",
          },
          state: "loaded",
        }}
        withdrawn={{
          title: "作品已移到回收站",
          description: "保留期内可以在回收站中恢复，恢复后为仅自己可见。",
        }}
      />,
    );
    expect(markup).toContain("data-detail-withdrawn");
    expect(markup).toContain("作品已移到回收站");
    expect(markup).not.toContain("data-detail-media-carousel");
    expect(markup).not.toContain("data-test-actions");
    expect(markup).not.toContain("data-comment-section");
    expect(markup).not.toContain("春日临帖");
    // The way back stays.
    expect(markup).toContain('aria-label="返回"');
  });

  it("keeps the withdrawal notice when the read then answers not-found", () => {
    const markup = renderToStaticMarkup(
      <CatalogDetailScreen
        activeMediaIndex={0}
        backButtonRef={createRef<HTMLButtonElement>()}
        onActiveMediaIndexChange={vi.fn()}
        onBack={vi.fn()}
        onOpenViewer={vi.fn()}
        orientation="portrait"
        platform="phone"
        state={{ state: "not-found" }}
        withdrawn={{
          title: "作品已永久删除",
          description: "此作品已无法恢复。",
        }}
      />,
    );
    expect(markup).toContain("data-detail-withdrawn");
    expect(markup).toContain("作品已永久删除");
    expect(markup).not.toContain("未找到这项资料");
    expect(markup).toContain('data-detail-state="not-found"');
  });

  it("marks only a loaded provisional work as provisional", () => {
    const work = {
      aliases: [],
      authorId: `user-${"a".repeat(32)}`,
      authorName: "临帖人",
      available: true,
      canEdit: false,
      contentType: "work" as const,
      facts: [],
      id: `work-${"a".repeat(32)}`,
      media: [],
      sections: [
        { key: "description" as const, title: "正文", text: "临帖一通" },
      ],
      source: "runtime" as const,
      sourceCitations: [],
      title: "春日临帖",
    };
    const provisional = renderState({
      detail: { ...work, provisional: true as const },
      state: "loaded",
    });
    expect(provisional).toContain('data-detail-provisional=""');
    expect(provisional).toContain('data-detail-state="loaded"');
    // The known work reads exactly as a confirmed one.
    expect(provisional).toContain("春日临帖");
    expect(provisional).toContain("临帖一通");
    expect(provisional.replace(' data-detail-provisional=""', "")).toBe(
      renderState({ detail: work, state: "loaded" }),
    );

    for (const markup of [
      renderState({ detail: work, state: "loaded" }),
      renderState({
        detail: {
          aliases: [],
          facts: [],
          id: "catalog-provisional",
          kind: "inscription",
          media: [],
          source: "runtime",
          sourceCitations: [],
          title: "碑刻",
        },
        state: "loaded",
      }),
      renderState({ state: "loading" }),
      renderState({ state: "not-found" }),
      renderState({ state: "unavailable" }),
    ])
      expect(markup).not.toContain("data-detail-provisional");
  });

  it("drops the provisional mark while a withdrawal notice replaces the known work", () => {
    const markup = renderToStaticMarkup(
      <CatalogDetailScreen
        activeMediaIndex={0}
        backButtonRef={createRef<HTMLButtonElement>()}
        onActiveMediaIndexChange={vi.fn()}
        onBack={vi.fn()}
        onOpenViewer={vi.fn()}
        orientation="portrait"
        platform="phone"
        state={{
          detail: {
            aliases: [],
            authorId: `user-${"a".repeat(32)}`,
            authorName: "临帖人",
            available: true,
            canEdit: true,
            contentType: "work",
            facts: [],
            id: `work-${"a".repeat(32)}`,
            media: [],
            provisional: true,
            sections: [],
            source: "runtime",
            sourceCitations: [],
            title: "春日临帖",
          },
          state: "loaded",
        }}
        withdrawn={{
          title: "作品已永久删除",
          description: "此作品已无法恢复。",
        }}
      />,
    );
    expect(markup).toContain("data-detail-withdrawn");
    expect(markup).toContain('data-detail-state="loaded"');
    expect(markup).not.toContain("data-detail-provisional");
    expect(markup).not.toContain("春日临帖");
  });
});
