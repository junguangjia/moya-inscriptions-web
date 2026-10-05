import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

// One successful compilation per owned server/worker; failed preparation is
// never cached. Browser journeys and each anonymous probe remain independent.
const prepared = new Map<string, Promise<void>>();

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
  const identity = origin || String(test.info().project.use.baseURL);
  let compilation = prepared.get(identity);
  if (!compilation) {
    compilation = Promise.all(
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
    ).then(() => {});
    prepared.set(identity, compilation);
    compilation.catch(() => {
      if (prepared.get(identity) === compilation) prepared.delete(identity);
    });
  }
  await compilation;
  const guestProbe = await request.get(`${origin}/api/community/me`, timeout());
  expect(guestProbe.status(), "Prepare anonymous identity probe").toBe(401);
};
