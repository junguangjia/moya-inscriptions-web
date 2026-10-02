// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { authorClient } from "../../../lib/public-api/author-community-client";
import { createArticleUploadSession } from "./article-upload-session";

afterEach(() => {
  authorClient.setAccount(null);
  vi.unstubAllGlobals();
});

it("opens and disposes the real Article upload session without secure-context randomUUID", () => {
  vi.stubGlobal("crypto", {
    getRandomValues: crypto.getRandomValues.bind(crypto),
  });
  const owner = `user-${"1".repeat(32)}`;
  authorClient.setAccount(owner);
  const session = createArticleUploadSession(owner);
  try {
    expect(session.manager.getSnapshot().accountId).toBe(owner);
    expect(session.manager.getSnapshot().items).toEqual([]);
  } finally {
    session.dispose();
  }
});
