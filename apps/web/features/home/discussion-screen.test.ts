// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { openerFeed } from "./discussion-screen";

/*
 * Owner acceptance (2026-09-25): an Article id alone does not say 近闻 or 专题,
 * so the Discussion pager follows the panel that holds the opened card.
 */
afterEach(() => document.body.replaceChildren());

const card = (panelId: string | null) => {
  const button = document.createElement("button");
  if (panelId === null) {
    document.body.append(button);
    return button;
  }
  const panel = document.createElement("div");
  panel.id = panelId;
  const feed = document.createElement("div");
  feed.append(button);
  panel.append(feed);
  document.body.append(panel);
  return button;
};

describe("openerFeed", () => {
  it("names the Discussion panel that holds the opened card", () => {
    expect(openerFeed(card("discussion-panel-topics"))).toBe("topics");
    expect(openerFeed(card("discussion-panel-news"))).toBe("news");
    expect(openerFeed(card("discussion-panel-threads"))).toBe("threads");
  });

  it("leaves a card outside the Discussion panels, or none, to the id prefix", () => {
    expect(openerFeed(undefined)).toBeNull();
    expect(openerFeed(card(null))).toBeNull();
    expect(openerFeed(card("discussion-panel-other"))).toBeNull();
  });
});
