import type { Metadata } from "next";
import { fetchServerEditorialPreview } from "../../../lib/public-api/editorial-preview-server";
import { readFormalRequestContext } from "../../formal-request-context";
import { EditorialPreviewExperience } from "./preview-experience";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "内容预览 · 由于艺",
  robots: { index: false, follow: false },
};

export default async function EditorialPreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [result, { initialPlatform }] = await Promise.all([
    fetchServerEditorialPreview(id),
    readFormalRequestContext(),
  ]);
  if (result.state !== "success") {
    const message =
      result.state === "unauthorized"
        ? "请在同一浏览器登录内容管理后打开预览。"
        : result.state === "incomplete"
          ? "草稿尚缺少标题。保存标题后即可预览。"
          : "暂时无法预览这项资料。";
    return (
      <main>
        <h1>内容预览</h1>
        <p role="status">{message}</p>
      </main>
    );
  }
  return (
    <EditorialPreviewExperience
      detail={result.detail}
      initialPlatform={initialPlatform}
    />
  );
}
