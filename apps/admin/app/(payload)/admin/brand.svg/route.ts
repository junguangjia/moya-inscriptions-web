import brandAsset from "@moya/ui/assets/brand/yoyi-logo.svg";

// Next emits this canonical asset with the Admin's existing assetPrefix.
// A relative Location keeps the browser's public origin behind the ingress;
// Next's internal request URL may use localhost in a standalone server.
export function GET() {
  return new Response(null, {
    status: 307,
    headers: { Location: brandAsset.src },
  });
}

export const HEAD = GET;
