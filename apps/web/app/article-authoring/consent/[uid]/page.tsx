import { notFound } from "next/navigation";
import { parseArticleConsentEntry } from "../../../../lib/public-api/article-agent-entry";
import { ArticleAgentPage } from "../../../../features/editorial-content/article-authoring/article-agent-page";
export default async function ArticleConsentPage({
  params,
}: {
  readonly params: Promise<{ uid: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();
  const uid = parseArticleConsentEntry((await params).uid);
  if (uid === null) notFound();
  return <ArticleAgentPage interactionUid={uid} />;
}
