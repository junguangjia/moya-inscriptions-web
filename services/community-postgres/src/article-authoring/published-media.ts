/** Internal SQL fragments receive only caller-owned SQL expressions. */
export const publishedArticleItemSql = (
  item: string,
  viewer: string,
  owner?: string,
): string => `EXISTS (
  SELECT 1 FROM community.media_item_refs article_ref
  JOIN community.article_revisions article_revision
    ON article_ref.holder_kind='article_revision'
    AND article_ref.holder_id='article-revision-' || substr(
      encode(sha256(convert_to(article_revision.article_id || ':' || article_revision.version::text,'UTF8')),'hex'),1,32)
  JOIN community.article_documents article_document
    ON article_document.id=article_revision.article_id
    AND article_document.published_version=article_revision.version
  JOIN community.public_users article_owner
    ON article_owner.id=article_document.owner_id AND article_owner.status='active'
  WHERE article_ref.item_id=${item}
    AND article_document.status<>'withdrawn'
    ${owner === undefined ? "" : `AND article_document.owner_id=${owner} AND article_revision.owner_id=${owner}`}
    AND community.accounts_can_interact(${viewer},article_document.owner_id)
)`;
