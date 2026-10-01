/** Canonical instants arrive from the Backend; Web formats them for display. */
export const formatEditorialTime = (
  iso: string,
  now: Date = new Date(),
): string => {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "";
  const day = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const diff = startOfToday.getTime() - time.getTime();
  if (time.getTime() >= startOfToday.getTime()) return "今天";
  if (diff < day) return "昨天";
  if (diff < 7 * day) return `${Math.ceil(diff / day)} 天前`;
  return `${time.getFullYear()}年${time.getMonth() + 1}月${time.getDate()}日`;
};
export const estimateReadingMinutes = (paragraphs: readonly string[]): number =>
  Math.max(
    1,
    Math.round(
      paragraphs.reduce((total, paragraph) => total + paragraph.length, 0) /
        400,
    ),
  );
