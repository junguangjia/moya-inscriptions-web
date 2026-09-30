import brandAsset from "@moya/ui/assets/brand/yoyi-logo.svg";

// Next emits this canonical asset with the Admin's existing assetPrefix.
// Keep Payload's configuration directly importable by its standalone CLI.
export function GET(request: Request) {
  return Response.redirect(new URL(brandAsset.src, request.url), 307);
}

export const HEAD = GET;
