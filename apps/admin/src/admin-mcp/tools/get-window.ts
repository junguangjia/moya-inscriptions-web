import type {
  AdminGetInput,
  AdminMcpEnvelope,
  AdminMcpNext,
} from "@moya/contracts/internal/admin-mcp";

import {
  codePointLength,
  FIND_DEFAULT_CONTEXT,
  findInText,
  textHash,
  textWindow,
} from "../text-window";

export const GET_TOOL_NAME = "admin_get";

export const nextOf = (
  input: AdminGetInput,
  changed: Partial<AdminGetInput>,
): AdminMcpNext => ({
  tool: GET_TOOL_NAME,
  args: { ...input, ...changed },
});

/** A bounded window of one field's text, or the matches inside it. */
export const windowOfField = (
  common: Readonly<Record<string, unknown>>,
  input: AdminGetInput,
  located: { readonly state: string; readonly text: string },
  answered: (data: unknown, untrusted: readonly string[]) => AdminMcpEnvelope,
): AdminMcpEnvelope => {
  const about = {
    ...common,
    field: input.field,
    fieldState: located.state,
    fieldHash: textHash(located.text),
    totalLength: codePointLength(located.text),
    offsetUnit: "codePoint",
  };
  if (input.find !== undefined) {
    const { count, matches, more } = findInText(
      located.text,
      input.find.text,
      input.find.mode ?? "raw",
      input.find.context ?? FIND_DEFAULT_CONTEXT,
      input.offset ?? 0,
    );
    const last = matches.at(-1);
    return {
      ...answered(
        { ...about, mode: input.find.mode ?? "raw", count, matches },
        [
          "/data/title",
          "/data/matches/*/before",
          "/data/matches/*/match",
          "/data/matches/*/after",
        ],
      ),
      ...(more && last !== undefined
        ? { next: nextOf(input, { offset: last.offset + 1 }) }
        : {}),
    };
  }
  const offset = input.offset ?? 0;
  const window = textWindow(located.text, offset, input.maxChars);
  return {
    ...answered(
      {
        ...about,
        offset,
        ...(window.nextOffset === undefined
          ? {}
          : { nextOffset: window.nextOffset }),
        text: window.text,
      },
      ["/data/title", "/data/text"],
    ),
    ...(window.nextOffset === undefined
      ? {}
      : { next: nextOf(input, { offset: window.nextOffset }) }),
  };
};
