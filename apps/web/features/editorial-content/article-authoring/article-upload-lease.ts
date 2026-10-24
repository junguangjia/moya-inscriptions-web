import { createTemporaryUploadLease } from "../../publishing/temporary-upload-lease";

/** Compatibility wrapper for the Article consumer of the shared temporary lease. */
export const createArticleUploadLease = (
  options: Parameters<typeof createTemporaryUploadLease>[0],
) => createTemporaryUploadLease({ ...options, errorPrefix: "article_upload" });
export type ArticleUploadLease = ReturnType<typeof createArticleUploadLease>;
