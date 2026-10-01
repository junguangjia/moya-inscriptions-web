import { CommunityNotFoundError } from "@moya/api";
import type { PublicUserId } from "@moya/contracts";
import type { PublishingMediaReadTarget } from "@moya/api";
import {
  derivativeReadSql,
  mediaReadTarget,
} from "../publishing/media-read.js";
import type { MediaReadTargetRow } from "../publishing/media-read.js";
import type { PublishingDb } from "../publishing/db.js";
import { articleReadyMediaSql } from "./media-read.js";

/** Called only while the delegated actor/current connection transaction is held. */
export const selectOwnArticleThumbnail = async (
  db: PublishingDb,
  owner: PublicUserId,
  itemId: string,
): Promise<PublishingMediaReadTarget | null> => {
  if (!/^media-item-[0-9a-f]{32}$/u.test(itemId))
    throw new CommunityNotFoundError();
  return mediaReadTarget(
    (
      await db.query<MediaReadTargetRow>(
        `${derivativeReadSql}
    AND i.owner_id=$4::text AND b.purpose='derivative' AND d.content_type='image/webp' AND ${articleReadyMediaSql("i")}`,
        [itemId, "thumb", "base", owner],
      )
    ).rows[0],
  );
};
