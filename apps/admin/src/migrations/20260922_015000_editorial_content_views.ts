import {
  sql,
  type MigrateUpArgs,
  type MigrateDownArgs,
} from "@payloadcms/db-postgres";
import {
  createPublishedArticleViewsSql,
  dropPublishedArticleViewsSql,
} from "../editorial-content/published";
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql.raw(createPublishedArticleViewsSql));
}
export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql.raw(dropPublishedArticleViewsSql));
}
