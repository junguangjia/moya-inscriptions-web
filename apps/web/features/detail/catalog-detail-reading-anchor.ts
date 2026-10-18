/** A vertical reading position survives columns reflowing after rotation. */
export interface DetailReadingAnchor {
  readonly id: string;
  readonly character: number;
  readonly rightDelta: number;
}

const marked = (root: HTMLElement) =>
  [
    ...root.querySelectorAll<HTMLElement>("[data-detail-reading-anchor]"),
  ].filter(
    (node) => node.querySelector("[data-detail-reading-anchor]") === null,
  );

const characters = (root: HTMLElement) => {
  const result: { node: Text; offset: number; length: number }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    let offset = 0;
    for (const character of node.data) {
      result.push({ node, offset, length: character.length });
      offset += character.length;
    }
  }
  return result;
};

const characterRect = (
  character: { node: Text; offset: number; length: number } | undefined,
) => {
  if (character === undefined) return null;
  const range = document.createRange();
  if (typeof range.getBoundingClientRect !== "function") return null;
  range.setStart(character.node, character.offset);
  range.setEnd(character.node, character.offset + character.length);
  const rect = range.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
};

export const captureDetailReadingAnchor = (
  root: HTMLElement,
  viewport: DOMRect,
): DetailReadingAnchor | null => {
  for (const element of marked(root)) {
    const box = element.getBoundingClientRect();
    if (box.right <= viewport.left || box.left >= viewport.right) continue;
    const text = characters(element);
    // Vertical-rl columns progress monotonically towards the left. Find the
    // first readable character rather than preserving a physical pixel page.
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const rect = characterRect(text[middle]);
      if (rect === null || rect.right <= viewport.right + 1) high = middle;
      else low = middle + 1;
    }
    const rect = characterRect(text[low]);
    return {
      id: element.dataset.detailReadingAnchor ?? "",
      character: low,
      rightDelta: viewport.right - (rect?.right ?? box.right),
    };
  }
  return null;
};

export const detailReadingAnchorOffset = (
  root: HTMLElement,
  viewport: DOMRect,
  currentOffset: number,
  anchor: DetailReadingAnchor,
): number | null => {
  const element = marked(root).find(
    (node) => node.dataset.detailReadingAnchor === anchor.id,
  );
  if (element === undefined) return null;
  const text = characters(element);
  const rect = characterRect(text[Math.min(anchor.character, text.length - 1)]);
  const right = rect?.right ?? element.getBoundingClientRect().right;
  return Math.max(
    0,
    currentOffset + viewport.right - right - anchor.rightDelta,
  );
};
