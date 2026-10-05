import { describe, expect, it, vi } from "vitest";
import type { APIRequestContext } from "@playwright/test";

vi.mock("@playwright/test", async () => ({
  expect: (await import("vitest")).expect,
  test: {
    info: () => ({ project: { use: { baseURL: "http://127.0.0.1:37430" } } }),
  },
}));

const { prepareFormalRoutes } =
  await import("../e2e/support/prepare-formal-routes");
const { readPagingWebPort } = await import("../e2e/support/e2e-ports");

describe("owned Formal route preparation", () => {
  it("reuses only successful compilation and checks the anonymous identity on every call", async () => {
    const get = vi.fn(async (url: string) => ({
      status: () => (url.endsWith("/me") ? 401 : 200),
    }));
    const request = { get } as unknown as APIRequestContext;
    await prepareFormalRoutes(request, "http://127.0.0.1:39801");
    expect(get).toHaveBeenCalledTimes(8);
    await prepareFormalRoutes(request, "http://127.0.0.1:39801");
    expect(get).toHaveBeenCalledTimes(9);
    expect(get.mock.calls.at(-1)![0]).toBe(
      "http://127.0.0.1:39801/api/community/me",
    );
    await prepareFormalRoutes(request, "http://127.0.0.1:39802");
    expect(get).toHaveBeenCalledTimes(17);
  });

  it("does not retain a failed preparation or conceal a later non-guest response", async () => {
    let compiled = false;
    let guest = true;
    const get = vi.fn(async (url: string) => ({
      status: () =>
        url.endsWith("/me") ? (guest ? 401 : 200) : compiled ? 200 : 503,
    }));
    const request = { get } as unknown as APIRequestContext;
    await expect(
      prepareFormalRoutes(request, "http://127.0.0.1:39803"),
    ).rejects.toThrow();
    compiled = true;
    await prepareFormalRoutes(request, "http://127.0.0.1:39803");
    expect(get).toHaveBeenCalledTimes(15);
    guest = false;
    await expect(
      prepareFormalRoutes(request, "http://127.0.0.1:39803"),
    ).rejects.toThrow();
  });

  it("refuses expired preparation and colliding paging service ports", async () => {
    const get = vi.fn();
    await expect(
      prepareFormalRoutes(
        { get } as unknown as APIRequestContext,
        "http://127.0.0.1:39804",
        Date.now() - 1,
      ),
    ).rejects.toThrow("deadline expired");
    expect(get).not.toHaveBeenCalled();
    expect(readPagingWebPort({})).toBe(3210);
    expect(() =>
      readPagingWebPort({ MOYA_E2E_PAGING_WEB_PORT: "3100" }),
    ).toThrow("separate");
    expect(() =>
      readPagingWebPort({ MOYA_E2E_PAGING_WEB_PORT: "3101" }),
    ).toThrow("separate");
    expect(() =>
      readPagingWebPort({ MOYA_E2E_PAGING_WEB_PORT: "invalid" }),
    ).toThrow("integer");
  });
});
