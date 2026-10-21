import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("Catalog Detail deep-link entry", () => {
  it("redirects safely into the existing T02 root shell", async () => {
    const response = await GET(
      new Request("http://localhost/catalog/%E7%A2%91%E5%88%BB%2F001"),
      { params: Promise.resolve({ catalogId: "碑刻/001" }) },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "/?catalogId=%E7%A2%91%E5%88%BB%2F001#detail-%E7%A2%91%E5%88%BB%2F001",
    );
  });

  it("never leaks the internal origin the proxy forwards to", async () => {
    const response = await GET(
      new Request("http://localhost:3000/catalog/a%20b"),
      { params: Promise.resolve({ catalogId: "a b" }) },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "/?catalogId=a%20b#detail-a%20b",
    );
    expect(response.headers.get("location")).not.toContain("localhost");
  });
});
