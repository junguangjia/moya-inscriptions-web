/*
 * Year text of the Home timeline. Years are signed and there is no year 0:
 * -475 reads 前475, and a year before 前841 reads 约前N.
 */

/** 共和元年: the first securely dated year; anything earlier reads 约. */
const FIRST_SECURE_YEAR = -841;
const YEAR_LIMIT = 3000;

const plainYear = (year: number): string =>
  year < 0 ? `前${-year}` : String(year);

export const formatYear = (year: number): string =>
  year < FIRST_SECURE_YEAR ? `约${plainYear(year)}` : plainYear(year);

/** `a–b`, an open `a–` when there is no end, one year when both are the same. */
export const formatYearRange = (start: number, end: number | null): string => {
  if (end === null) return `${formatYear(start)}–`;
  return start === end
    ? formatYear(start)
    : `${formatYear(start)}–${plainYear(end)}`;
};

/** The narrow year gutter prints a range on two lines, 前219 over –前209. */
export const formatYearLines = (
  start: number,
  end: number,
): readonly string[] =>
  start === end
    ? [formatYear(start)]
    : [formatYear(start), `–${plainYear(end)}`];

/** Years between two signed years, which cross no year 0. */
export const elapsedYears = (from: number, to: number): number =>
  to - from - (from < 0 && to > 0 ? 1 : 0);

export const formatGap = (years: number): string => `隔 ${years} 年`;

const asciiDigits = (text: string): string =>
  text.replace(/[０-９]/gu, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
  );

/** The 年份 box: digits, optionally 前 or a minus for BCE; 0 is no year. */
export const parseYearInput = (
  text: string,
  beforeCommonEra: boolean,
): number | null => {
  const match = /^(前|-|−)?([0-9]{1,4})$/u.exec(asciiDigits(text.trim()));
  if (match === null) return null;
  const year = Number(match[2]);
  if (year === 0 || year > YEAR_LIMIT) return null;
  return beforeCommonEra || match[1] !== undefined ? -year : year;
};

/** A share of the 总尺, as a CSS length. */
export const formatPercent = (fraction: number): string =>
  `${(fraction * 100).toFixed(3)}%`;

/** `?year=` as this feed writes it: a signed integer, never 0. */
export const parseYearParam = (value: string | null): number | null => {
  if (value === null || !/^-?[1-9][0-9]{0,3}$/u.test(value)) return null;
  const year = Number(value);
  return Math.abs(year) > YEAR_LIMIT ? null : year;
};
