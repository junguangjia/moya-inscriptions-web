import { notFound } from "next/navigation";
import { parseArticleApprovalEntry } from "../../../lib/public-api/article-agent-entry";
import { ArticleAgentPage } from "../../../features/editorial-content/article-authoring/article-agent-page";
export default async function ArticleApprovalPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const candidate = parseArticleApprovalEntry(await searchParams);
  if (candidate === null) notFound();
  return <ArticleAgentPage candidate={candidate} />;
}
