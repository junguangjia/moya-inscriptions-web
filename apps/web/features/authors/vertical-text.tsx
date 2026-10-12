import { Fragment } from "react";
import { formatCommentTimeLabel } from "../comments/live-comments";
import styles from "./feed-colophon.module.css";

const hanidec = new Intl.NumberFormat("zh-CN-u-nu-hanidec", {
  useGrouping: false,
});

/** Chinese numerals digit by digit, so leading zeros survive (2026 → 二〇二六). */
export const hanidecDigits = (digits: string): string =>
  [...digits].map((digit) => hanidec.format(Number(digit))).join("");

/**
 * Digits for a vertical line: runs of one or two stand upright side by side
 * (tate-chu-yoko); longer runs become Chinese numerals, with the original
 * digits kept for assistive technology.
 */
export const VerticalDigits = ({ text }: { readonly text: string }) => (
  <>
    {text.split(/(\d+)/).map((part, index) => {
      if (index % 2 === 0) return part === "" ? null : part;
      return part.length <= 2 ? (
        <span className={styles.tcy} key={index}>
          {part}
        </span>
      ) : (
        <Fragment key={index}>
          <span aria-hidden="true">{hanidecDigits(part)}</span>
          <span className={styles.srOnly}>{part}</span>
        </Fragment>
      );
    })}
  </>
);

// Curly quotes lie sideways (WebKit) or sit in horizontal form (Chromium) in
// a vertical line; corner brackets are the vertical-text quotes. A single
// quote between Latin letters is an apostrophe and stays.
const QUOTE_MAP: Readonly<Record<string, string>> = {
  "\u201c": "\u300c",
  "\u201d": "\u300d",
  "\u2018": "\u300e",
  "\u2019": "\u300f",
};
const QUOTES = /(?<![A-Za-z])[\u2018\u2019](?![A-Za-z])|[\u201c\u201d]/g;

/** Quotes for display in a vertical line; the stored text never changes. */
export const verticalQuotes = (text: string): string =>
  text.replace(QUOTES, (quote) => QUOTE_MAP[quote] ?? quote);

// A run of one or two digits standing alone (not inside a number, a time or
// a Latin word) is set upright; longer runs keep the reader's own digits.
const SHORT_DIGITS =
  /(?<![\p{Script=Latin}\p{N}_.,:/])(\d{1,2})(?![\p{Script=Latin}\p{N}_.,:/])/u;
const SHORT_DIGITS_SPLIT = new RegExp(SHORT_DIGITS.source, "gu");

/**
 * A reader's text in a vertical line: corner-bracket quotes, and short digit
 * runs upright side by side (10月9日). The text itself is never rewritten
 * into numerals.
 */
export const VerticalText = ({ text }: { readonly text: string }) => (
  <>
    {verticalQuotes(text)
      .split(SHORT_DIGITS_SPLIT)
      .map((part, index) =>
        index % 2 === 0 ? (
          part === "" ? null : (
            <Fragment key={index}>{part}</Fragment>
          )
        ) : (
          <span className={styles.tcy} key={index}>
            {part}
          </span>
        ),
      )}
  </>
);

/**
 * What a copy of the selection should carry: WebKit copies upright digits
 * as U+FFFC, and the numerals shown for long runs are decoration; the text
 * of each range without its hidden parts is what the reader selected.
 */
export const colophonClipboardText = (selection: Selection): string => {
  const parts: string[] = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const fragment = selection.getRangeAt(index).cloneContents();
    for (const hidden of fragment.querySelectorAll('[aria-hidden="true"]'))
      hidden.remove();
    parts.push(fragment.textContent ?? "");
  }
  return parts.join("\n");
};

/**
 * The short colophon time: the comment list's relative label for the first
 * week, then a written date (the year only when it is not the current one).
 */
export const formatColophonTime = (createdAt: string, now: Date): string => {
  const label = formatCommentTimeLabel(createdAt, now);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label);
  if (date === null) return label.replace(/(\d)\s+/g, "$1");
  const [, year, month, day] = date;
  const short = `${Number(month)}月${Number(day)}日`;
  return Number(year) === now.getUTCFullYear() ? short : `${year}年${short}`;
};
