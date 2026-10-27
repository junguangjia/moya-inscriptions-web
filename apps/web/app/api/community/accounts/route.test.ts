import { beforeEach, describe, expect, it, vi } from "vitest";

const { relayMock } = vi.hoisted(() => ({ relayMock: vi.fn() }));

vi.mock("../../../../lib/public-api/server", () => ({
  relayServerCommunityAccounts: relayMock,
}));

import { GET } from "./route";
import { POST } from "./switch/route";

beforeEach(() => {
  relayMock.mockReset();
  relayMock.mockResolvedValue(new Response(null, { status: 204 }));
});

// account-switching-v1: each route hands its request to the one account relay.
describe("account routes", () => {
  it("lists with GET and switches with POST through the account relay", async () => {
    const list = new Request("http://localhost/api/community/accounts");
    const swap = new Request("http://localhost/api/community/accounts/switch", {
      method: "POST",
      body: "{}",
    });
    expect((await GET(list)).status).toBe(204);
    expect((await POST(swap)).status).toBe(204);
    expect(relayMock.mock.calls).toEqual([
      [list, "list"],
      [swap, "switch"],
    ]);
  });
});
