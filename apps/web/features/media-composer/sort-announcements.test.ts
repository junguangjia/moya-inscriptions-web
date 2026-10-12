import { describe, expect, it } from "vitest";

import { sortAnnouncements } from "./sort-announcements";

import type { Active, Over } from "@dnd-kit/core";

const keys = ["a", "b", "c"];
const active = (id: string) => ({ id }) as unknown as Active;
const over = (id: string) => ({ id }) as unknown as Over;

describe("sortAnnouncements", () => {
  it("names logical positions only, without the 首图 option", () => {
    const say = sortAnnouncements(keys);
    expect(say.onDragStart({ active: active("a") })).toBe("已拿起第 1 项。");
    expect(say.onDragOver({ active: active("c"), over: over("a") })).toBe(
      "第 3 项将移到第 1 位。",
    );
    expect(say.onDragOver({ active: active("c"), over: null })).toBe(
      "第 3 项不在可放置的位置。",
    );
    expect(say.onDragEnd({ active: active("c"), over: over("a") })).toBe(
      "第 3 项已移到第 1 位。",
    );
    expect(say.onDragEnd({ active: active("a"), over: over("c") })).toBe(
      "第 1 项已移到第 3 位。",
    );
    expect(say.onDragEnd({ active: active("b"), over: null })).toBe(
      "第 2 项已放回原位。",
    );
    expect(say.onDragCancel({ active: active("b"), over: null })).toBe(
      "已取消移动，第 2 项回到原位。",
    );
  });

  it("says who is, or becomes, 首图 with the option (r4 R4)", () => {
    const say = sortAnnouncements(keys, { first: "首图" });
    expect(say.onDragStart({ active: active("a") })).toBe(
      "已拿起第 1 项（首图）。",
    );
    expect(say.onDragOver({ active: active("c"), over: over("a") })).toBe(
      "第 3 项将移到第 1 位，成为首图。",
    );
    expect(say.onDragEnd({ active: active("c"), over: over("a") })).toBe(
      "第 3 项已移到第 1 位，现在是首图。",
    );
    expect(say.onDragEnd({ active: active("a"), over: over("c") })).toBe(
      "第 1 项已移到第 3 位，原第 2 项现在是首图。",
    );
  });

  it("keeps the plain wording where position 1 does not change hands", () => {
    const say = sortAnnouncements(keys, { first: "首图" });
    expect(say.onDragStart({ active: active("b") })).toBe("已拿起第 2 项。");
    expect(say.onDragOver({ active: active("b"), over: over("c") })).toBe(
      "第 2 项将移到第 3 位。",
    );
    expect(say.onDragOver({ active: active("a"), over: over("a") })).toBe(
      "第 1 项将移到第 1 位。",
    );
    expect(say.onDragOver({ active: active("a"), over: over("c") })).toBe(
      "第 1 项将移到第 3 位。",
    );
    expect(say.onDragEnd({ active: active("b"), over: over("c") })).toBe(
      "第 2 项已移到第 3 位。",
    );
    expect(say.onDragEnd({ active: active("a"), over: over("a") })).toBe(
      "第 1 项已移到第 1 位。",
    );
    expect(say.onDragEnd({ active: active("a"), over: null })).toBe(
      "第 1 项已放回原位。",
    );
    expect(say.onDragCancel({ active: active("a"), over: null })).toBe(
      "已取消移动，第 1 项回到原位。",
    );
  });

  it("uses the word it is given (ASK-4's 首页)", () => {
    const say = sortAnnouncements(keys, { first: "首页" });
    expect(say.onDragEnd({ active: active("b"), over: over("a") })).toBe(
      "第 2 项已移到第 1 位，现在是首页。",
    );
  });
});
