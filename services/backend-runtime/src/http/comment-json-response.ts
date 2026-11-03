import {
  COMMENT_IMAGE_CAPABILITY_HEADER,
  commentImagePayloadFor,
} from "@moya/contracts/comment-images-protocol";
import { sendJson } from "./json-response.js";
import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";

/** Serialize only an already-authorized comment result, never a media response. */
export const sendCommentJson = (
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  payload: unknown,
  headers: OutgoingHttpHeaders = {},
): void => {
  const names = new Map<string, string>();
  const outgoing = { ...headers };
  const add = (value: string | number | readonly string[] | undefined) => {
    for (const line of Array.isArray(value) ? value : [value]) {
      if (line === undefined) continue;
      for (const name of String(line)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean))
        if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    }
  };
  add(response.getHeader("vary"));
  for (const key of Object.keys(outgoing)) {
    if (key.toLowerCase() !== "vary") continue;
    add(outgoing[key]);
    delete outgoing[key];
  }
  add("Authorization");
  add(COMMENT_IMAGE_CAPABILITY_HEADER);
  sendJson(
    response,
    status,
    commentImagePayloadFor(
      request.headers[COMMENT_IMAGE_CAPABILITY_HEADER],
      payload,
    ),
    {
      "cache-control": "private, no-store",
      ...outgoing,
      vary: [...names.values()].join(", "),
    },
  );
};
