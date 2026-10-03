import { notFound } from "next/navigation";
import config from "@payload-config";
import { RootPage, generatePageMetadata } from "@payloadcms/next/views";
import { importMap } from "../importMap";
export const dynamic = "force-dynamic";
type Args = {
  params: Promise<{ segments: string[] }>;
  searchParams: Promise<{ [key: string]: string | string[] }>;
};
export const generateMetadata = ({ params, searchParams }: Args) =>
  generatePageMetadata({ config, params, searchParams });
export default async function Page({ params, searchParams }: Args) {
  if (
    process.env.CMS_ENVIRONMENT !== "synthetic" &&
    (await params).segments?.[0] === "create-first-user"
  )
    notFound();
  return RootPage({ config, importMap, params, searchParams });
}
