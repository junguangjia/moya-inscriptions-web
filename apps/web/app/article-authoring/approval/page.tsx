import { notFound } from "next/navigation";
import { parseArticleApprovalEntry } from "../../../lib/public-api/article-agent-entry";
import { ArticleAgentPage } from "../../../features/editorial-content/article-authoring/article-agent-page";
import { ProductAccessNotice } from "../../../features/product-access/product-access-notice";
import { readVisitorAccess } from "../../product-access";
export default async function ArticleApprovalPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const candidate = parseArticleApprovalEntry(await searchParams);
  if (candidate === null) notFound();
  const access = await readVisitorAccess();
  if (access.state !== "granted")
    return <ProductAccessNotice access={access} />;
  return <ArticleAgentPage candidate={candidate} />;
}
