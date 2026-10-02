import type { ArticleBlock, MediaCrop } from "@moya/contracts";
import { normalizeCrop } from "../../publishing/ui/media/media-geometry";

type ImageProps = Extract<ArticleBlock, { type: "managedImage" }>["props"];

/** A crop belongs to this body block, never to the shared source asset. */
export const getArticleImageCrop = (props: ImageProps): MediaCrop | null =>
  props.cropX === undefined ||
  props.cropY === undefined ||
  props.cropWidth === undefined ||
  props.cropHeight === undefined
    ? null
    : normalizeCrop({
        x: props.cropX,
        y: props.cropY,
        width: props.cropWidth,
        height: props.cropHeight,
      });

export const articleImageCropProps = (crop: MediaCrop | null) => ({
  cropX: crop?.x ?? 0,
  cropY: crop?.y ?? 0,
  cropWidth: crop?.width ?? 1,
  cropHeight: crop?.height ?? 1,
});
