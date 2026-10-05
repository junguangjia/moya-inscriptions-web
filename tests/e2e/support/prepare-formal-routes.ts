import { expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

/** Compile the disposable Development routes before a page subscribes to HMR. */
export const prepareFormalRoutes = async (
  request: APIRequestContext,
  origin = "",
  deadline?: number,
) => {
  const timeout = () => {
    if (deadline === undefined) return {};
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error("Formal route preparation deadline expired");
    return { timeout: remaining };
  };
  await Promise.all(
    [
      "/",
      "/dev/t02p",
      "/dev/t02p/qa",
      "/api/community/filter-options",
      "/api/community/editorial/articles?page=1&pageSize=12&presentation=news",
      "/api/community/editorial/articles?page=1&pageSize=12&presentation=academic",
      "/api/community/threads?page=1&pageSize=22",
    ].map(async (path) => {
      const response = await request.get(`${origin}${path}`, timeout());
      expect(response.status(), `Prepare ${path}`).toBe(200);
    }),
  );
  const guestProbe = await request.get(`${origin}/api/community/me`, timeout());
  expect(guestProbe.status(), "Prepare anonymous identity probe").toBe(401);
};
