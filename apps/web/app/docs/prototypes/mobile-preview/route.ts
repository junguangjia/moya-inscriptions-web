import {
  methodNotAllowed,
  readT02Document,
} from "../../../../lib/t02-static-files";

import { isProductAccessGranted } from "../../../product-access";

export const runtime = "nodejs";

// Prototype documents carry sample records: they follow product access too.
// The answer depends on who asks, so no cache may keep it for someone else.
const answer = async (request: Request, method: "GET" | "HEAD") => {
  const response = (await isProductAccessGranted(request))
    ? await readT02Document(method)
    : new Response(null, { status: 404 });
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Vary", "Cookie");
  return response;
};

export const GET = (request: Request) => answer(request, "GET");
export const HEAD = (request: Request) => answer(request, "HEAD");
export const POST = methodNotAllowed;
