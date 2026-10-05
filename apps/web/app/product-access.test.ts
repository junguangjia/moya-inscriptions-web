import { beforeEach, describe, expect, it, vi } from "vitest";

const { accessMock, cookieHeader, currentUserMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  cookieHeader: { value: null as string | null },
  currentUserMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => (name === "cookie" ? cookieHeader.value : null),
  }),
}));
vi.mock("../lib/public-api/server", () => ({
  fetchServerCurrentUser: currentUserMock,
  fetchServerProductAccess: accessMock,
}));

import { isProductAccessGranted, readVisitorAccess } from "./product-access";

const session = "s".repeat(43);
const answer = (mode: string, access: string) => ({
  state: "success",
  access: { mode, access },
});

beforeEach(() => {
  accessMock.mockReset();
  currentUserMock.mockReset();
  cookieHeader.value = null;
});

describe("visitor access, as the Backend answers it", () => {
  it("grants in public mode with or without a session, and never asks who the visitor is", async () => {
    accessMock.mockResolvedValue(answer("public", "granted"));
    await expect(readVisitorAccess()).resolves.toEqual({
      state: "granted",
      closedBeta: false,
      token: undefined,
    });
    expect(accessMock).toHaveBeenCalledWith(undefined);
    cookieHeader.value = `yoyi-session=${session}`;
    await expect(readVisitorAccess()).resolves.toEqual({
      state: "granted",
      closedBeta: false,
      token: session,
    });
    expect(accessMock).toHaveBeenLastCalledWith(session);
    expect(currentUserMock).not.toHaveBeenCalled();
  });

  it("hands an approved visitor's session on in a closed beta", async () => {
    cookieHeader.value = `theme=dark; yoyi-session=${session}`;
    accessMock.mockResolvedValue(answer("closed_beta", "granted"));
    await expect(readVisitorAccess()).resolves.toEqual({
      state: "granted",
      closedBeta: true,
      token: session,
    });
  });

  it("asks an anonymous visitor to sign in", async () => {
    accessMock.mockResolvedValue(answer("closed_beta", "sign_in_required"));
    await expect(readVisitorAccess()).resolves.toEqual({
      state: "sign_in_required",
    });
    // A cookie that is not a session is no session.
    cookieHeader.value = "yoyi-session=forged";
    await readVisitorAccess();
    expect(accessMock).toHaveBeenLastCalledWith(undefined);
  });

  it("names a refused account only from the Backend's own identity answer", async () => {
    cookieHeader.value = `yoyi-session=${session}`;
    accessMock.mockResolvedValue(answer("closed_beta", "restricted"));
    currentUserMock.mockResolvedValue({
      state: "success",
      profile: {
        id: "user-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f04",
        handle: "member-04",
        displayName: "访碑者",
      },
    });
    await expect(readVisitorAccess()).resolves.toEqual({
      state: "restricted",
      account: { displayName: "访碑者", handle: "member-04" },
    });
    expect(currentUserMock).toHaveBeenCalledWith(session);
    currentUserMock.mockResolvedValue({ state: "unavailable" });
    await expect(readVisitorAccess()).resolves.toEqual({
      state: "restricted",
      account: null,
    });
  });

  it("fails closed when the Backend gives no answer", async () => {
    accessMock.mockResolvedValue({ state: "unavailable" });
    await expect(readVisitorAccess()).resolves.toEqual({
      state: "unavailable",
    });
  });

  it("lets a content route proceed only on a clear grant", async () => {
    const request = (cookie?: string) =>
      new Request("http://localhost/docs/prototypes/mobile-preview", {
        headers: cookie === undefined ? {} : { cookie },
      });
    accessMock.mockResolvedValue(answer("public", "granted"));
    await expect(isProductAccessGranted(request())).resolves.toBe(true);
    accessMock.mockResolvedValue(answer("closed_beta", "granted"));
    await expect(
      isProductAccessGranted(request(`yoyi-session=${session}`)),
    ).resolves.toBe(true);
    expect(accessMock).toHaveBeenLastCalledWith(session);
    for (const refused of [
      answer("closed_beta", "sign_in_required"),
      answer("closed_beta", "restricted"),
      { state: "unavailable" },
    ]) {
      accessMock.mockResolvedValue(refused);
      currentUserMock.mockResolvedValue({ state: "unavailable" });
      await expect(isProductAccessGranted(request())).resolves.toBe(false);
    }
  });
});
