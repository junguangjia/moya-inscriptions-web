import { beforeEach, describe, expect, it, vi } from "vitest";

const { granted, readDocument, serveFile } = vi.hoisted(() => ({
  granted: vi.fn(),
  readDocument: vi.fn(),
  serveFile: vi.fn(),
}));

vi.mock("../../../product-access", () => ({
  isProductAccessGranted: granted,
}));
vi.mock("../../../../lib/t02-static-files", () => ({
  methodNotAllowed: () => new Response(null, { status: 405 }),
  readT02Document: readDocument,
  serveT02File: serveFile,
}));

import * as document from "./route";
import * as files from "./[...path]/route";

const request = new Request("http://localhost/docs/prototypes/mobile-preview");
const context = {
  params: Promise.resolve({ path: ["fixtures", "p5-pilot.snapshot.js"] }),
};

beforeEach(() => {
  granted.mockReset();
  readDocument.mockReset();
  serveFile.mockReset();
  readDocument.mockResolvedValue(new Response("document"));
  serveFile.mockResolvedValue(new Response("file"));
});

describe("prototype documents follow product access", () => {
  it("serves the document and its files to a visitor with access, as before", async () => {
    granted.mockResolvedValue(true);
    expect(await (await document.GET(request)).text()).toBe("document");
    expect(readDocument).toHaveBeenCalledWith("GET");
    await document.HEAD(request);
    expect(readDocument).toHaveBeenLastCalledWith("HEAD");
    expect(await (await files.GET(request, context)).text()).toBe("file");
    expect(serveFile).toHaveBeenCalledWith(
      { kind: "prototype", segments: ["fixtures", "p5-pilot.snapshot.js"] },
      "GET",
    );
    await files.HEAD(request, context);
    expect(serveFile).toHaveBeenLastCalledWith(
      { kind: "prototype", segments: ["fixtures", "p5-pilot.snapshot.js"] },
      "HEAD",
    );
    expect(granted).toHaveBeenCalledWith(request);
  });

  it("answers 404 without reading anything for a visitor without access", async () => {
    granted.mockResolvedValue(false);
    for (const response of [
      await document.GET(request),
      await document.HEAD(request),
      await files.GET(request, context),
      await files.HEAD(request, context),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
    expect(readDocument).not.toHaveBeenCalled();
    expect(serveFile).not.toHaveBeenCalled();
  });
});
