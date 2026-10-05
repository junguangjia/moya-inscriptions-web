import {
  methodNotAllowed,
  serveT02File,
} from "../../../../../lib/t02-static-files";

import { isProductAccessGranted } from "../../../../product-access";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ path: string[] }> };

// Prototype files include sample records: they follow product access too.
const serve = async (
  request: Request,
  context: RouteContext,
  method: "GET" | "HEAD",
) =>
  (await isProductAccessGranted(request))
    ? serveT02File(
        { kind: "prototype", segments: (await context.params).path },
        method,
      )
    : new Response(null, { status: 404 });

export const GET = (request: Request, context: RouteContext) =>
  serve(request, context, "GET");
export const HEAD = (request: Request, context: RouteContext) =>
  serve(request, context, "HEAD");
export const POST = methodNotAllowed;
