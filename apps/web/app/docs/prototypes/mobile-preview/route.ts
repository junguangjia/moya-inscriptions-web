import {
  methodNotAllowed,
  readT02Document,
} from "../../../../lib/t02-static-files";

import { isProductAccessGranted } from "../../../product-access";

export const runtime = "nodejs";

// Prototype documents carry sample records: they follow product access too.
const notFound = () => new Response(null, { status: 404 });

export const GET = async (request: Request) =>
  (await isProductAccessGranted(request)) ? readT02Document("GET") : notFound();
export const HEAD = async (request: Request) =>
  (await isProductAccessGranted(request))
    ? readT02Document("HEAD")
    : notFound();
export const POST = methodNotAllowed;
