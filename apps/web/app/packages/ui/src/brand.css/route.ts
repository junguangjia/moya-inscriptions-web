import {
  methodNotAllowed,
  serveT02File,
} from "../../../../../lib/t02-static-files";

export const runtime = "nodejs";

export const GET = () =>
  serveT02File({ kind: "ui-styles", segments: ["brand.css"] }, "GET");
export const HEAD = () =>
  serveT02File({ kind: "ui-styles", segments: ["brand.css"] }, "HEAD");
export const POST = methodNotAllowed;
