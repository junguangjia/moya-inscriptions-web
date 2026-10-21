export const runtime = "nodejs";

interface CatalogDetailEntryRouteContext {
  params: Promise<{ catalogId: string }>;
}

export const GET = async (
  _request: Request,
  context: CatalogDetailEntryRouteContext,
): Promise<Response> => {
  const { catalogId } = await context.params;
  const encodedCatalogId = encodeURIComponent(catalogId);

  // A redirect with a relative Location resolves against the public host the
  // browser used. Behind the proxy, request.url is the internal origin
  // (localhost:3000), so it must not be used to build the destination.
  return new Response(null, {
    status: 307,
    headers: {
      Location: `/?catalogId=${encodedCatalogId}#detail-${encodedCatalogId}`,
    },
  });
};
