import { describe, expect, it } from "vitest";

import {
  elapsedYears,
  formatGap,
  formatYear,
  formatYearLines,
  formatYearRange,
  parseYearInput,
  parseYearParam,
} from "./timeline-format";

describe("timeline year text", () => {
  it("prints 前 for negative years and 约 only before 前841", () => {
    expect(formatYear(-475)).toBe("前475");
    expect(formatYear(-841)).toBe("前841");
    expect(formatYear(-842)).toBe("约前842");
    expect(formatYear(-1250)).toBe("约前1250");
    expect(formatYear(140)).toBe("140");
  });

  it("prints a range with 约 on its start only", () => {
    expect(formatYearRange(-1250, -1046)).toBe("约前1250–前1046");
    expect(formatYearRange(-1046, -771)).toBe("约前1046–前771");
    expect(formatYearRange(-206, 23)).toBe("前206–23");
    expect(formatYearRange(618, 907)).toBe("618–907");
    expect(formatYearRange(511, 511)).toBe("511");
    expect(formatYearRange(1949, null)).toBe("1949–");
  });

  it("breaks a range over two gutter lines", () => {
    expect(formatYearLines(140, 140)).toEqual(["140"]);
    expect(formatYearLines(-219, -209)).toEqual(["前219", "–前209"]);
    expect(formatYearLines(147, 149)).toEqual(["147", "–149"]);
  });

  it("counts elapsed years across the missing year 0", () => {
    expect(elapsedYears(-26, 7)).toBe(32);
    expect(elapsedYears(-149, -56)).toBe(93);
    expect(elapsedYears(100, 137)).toBe(37);
    expect(elapsedYears(-1, 1)).toBe(1);
    expect(formatGap(93)).toBe("隔 93 年");
  });

  it("parses the year box", () => {
    expect(parseYearInput("511", false)).toBe(511);
    expect(parseYearInput("219", true)).toBe(-219);
    expect(parseYearInput("前219", false)).toBe(-219);
    expect(parseYearInput("-219", false)).toBe(-219);
    expect(parseYearInput("−219", false)).toBe(-219);
    expect(parseYearInput(" ５１１ ", false)).toBe(511);
    expect(parseYearInput("0", false)).toBeNull();
    expect(parseYearInput("", false)).toBeNull();
    expect(parseYearInput("开元", false)).toBeNull();
    expect(parseYearInput("9999", false)).toBeNull();
  });

  it("parses the URL year this feed writes", () => {
    expect(parseYearParam("511")).toBe(511);
    expect(parseYearParam("-219")).toBe(-219);
    expect(parseYearParam("0")).toBeNull();
    expect(parseYearParam("05")).toBeNull();
    expect(parseYearParam("abc")).toBeNull();
    expect(parseYearParam("9000")).toBeNull();
    expect(parseYearParam(null)).toBeNull();
  });
});
