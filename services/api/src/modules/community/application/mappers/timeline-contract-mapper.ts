import { timelineSchema } from "@moya/contracts/schemas";

import type { TimelineRecord } from "../ports/community-discovery-port.js";
import type { ContentCard, Timeline } from "@moya/contracts";

/**
 * The public timeline, validated. A linked row shows its card's image; a card
 * image carries no alt, so the row's full title names what it shows.
 */
export const mapTimeline = (
  entries: TimelineRecord["entries"],
  cards: readonly ContentCard[],
): Timeline => {
  const images = new Map(cards.map((card) => [card.target.id, card.media]));
  return timelineSchema.parse({
    entries: entries.map((entry) => {
      const image =
        entry.catalogId === null ? undefined : images.get(entry.catalogId);
      return {
        ...entry,
        media: image ? { ...image, kind: "image", alt: entry.fullTitle } : null,
      };
    }),
  });
};
