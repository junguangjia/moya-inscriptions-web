import {
  methodNotAllowed,
  serveT02File,
} from "../../../../../lib/t02-static-files";

import { isProductAccessGranted } from "../../../../product-access";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ path: string[] }> };

// Prototype files include sample records: they follow product access too.
// The answer depends on who asks, so no cache may keep it for someone else.
const serve = async (
  request: Request,
  context: RouteContext,
  method: "GET" | "HEAD",
) => {
  const response = (await isProductAccessGranted(request))
    ? await serveT02File(
        { kind: "prototype", segments: (await context.params).path },
        method,
      )
    : new Response(null, { status: 404 });
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Vary", "Cookie");
  return response;
};

export const GET = (request: Request, context: RouteContext) =>
  serve(request, context, "GET");
export const HEAD = (request: Request, context: RouteContext) =>
  serve(request, context, "HEAD");
export const POST = methodNotAllowed;
