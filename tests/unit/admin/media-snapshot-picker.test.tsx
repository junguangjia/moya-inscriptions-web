// @vitest-environment jsdom
import { createElement } from "react";
import type { ComponentType, ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const { join } = await import("node:path");
  const require = createRequire(
    join(import.meta.dirname, "../../../apps/admin/"),
  );
  return {
    ui: realpathSync(require.resolve("@payloadcms/ui")),
    catalogDocumentId: 10 as number | undefined,
    fields: {} as Record<string, { value?: unknown; rows?: { id: string }[] }>,
    fetch: vi.fn(),
    dispatchFields: vi.fn(),
    setModified: vi.fn(),
    addFieldRow: vi.fn(),
    select: null as null | ((args: { doc: { id: number } }) => void),
  };
});

vi.mock(runtime.ui, () => ({
  Button: ({
    children,
    buttonStyle: _style,
    ...props
  }: {
    children: ReactNode;
    buttonStyle?: string;
  }) => {
    void _style;
    return createElement("button", props, children);
  },
  useConfig: () => ({ config: { routes: { api: "/api" } } }),
  useDocumentInfo: () => ({ id: runtime.catalogDocumentId }),
  useField: () => ({ value: "synthetic-catalog" }),
  useFormFields: (selector: (args: [typeof runtime.fields]) => unknown) =>
    selector([runtime.fields]),
  useForm: () => ({
    addFieldRow: runtime.addFieldRow,
    getDataByPath: () => [
      {
        mediaId: "synthetic-image-one",
        position: 4,
        rights: "原始声明",
        orderConfidence: "LOW",
      },
      { mediaId: "synthetic-image-two", position: 7 },
    ],
    getFields: () => runtime.fields,
    dispatchFields: runtime.dispatchFields,
    setModified: runtime.setModified,
  }),
  useListDrawer: () => [
    ({ onSelect }: { onSelect: typeof runtime.select }) => {
      runtime.select = onSelect;
      return null;
    },
    "list",
    { openDrawer: vi.fn(), closeDrawer: vi.fn() },
  ],
  useDocumentDrawer: () => [
    () => null,
    "upload",
    { openDrawer: vi.fn(), closeDrawer: vi.fn() },
  ],
}));

import { MediaSnapshotPicker } from "admin/media-snapshot-picker";
const Picker = MediaSnapshotPicker as ComponentType;

beforeEach(() => {
  runtime.catalogDocumentId = 10;
  runtime.fields = {
    media: { rows: [{ id: "row-one" }, { id: "row-two" }] },
    "media.0.mediaId": { value: "synthetic-image-one" },
    "media.0.alt": { value: "第一张图片" },
    "media.0.isRepresentative": { value: true },
    "media.0.position": { value: 4 },
    "media.0.rights": { value: "原始声明" },
    "media.0.orderConfidence": { value: "LOW" },
    "media.1.mediaId": { value: "synthetic-image-two" },
    "media.1.alt": { value: "第二张图片" },
    "media.1.isRepresentative": { value: false },
    "media.1.position": { value: 7 },
  };
  runtime.fetch.mockReset();
  runtime.dispatchFields.mockReset();
  runtime.setModified.mockReset();
  runtime.addFieldRow.mockReset();
  runtime.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      docs: [
        {
          mediaId: "synthetic-image-one",
          thumbnailURL: "/api/catalog-media-thumbnail?fixture=file/one.webp",
          objectKey: "must-not-be-used",
        },
        {
          mediaId: "synthetic-image-two",
          thumbnailURL: "/api/catalog-media-thumbnail?fixture=file/two.webp",
        },
      ],
    }),
  });
  vi.stubGlobal("fetch", runtime.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Catalog native media form controls", () => {
  it("loads authenticated native thumbnails without deriving URLs from storage metadata", async () => {
    render(createElement(Picker));
    await waitFor(() =>
      expect(screen.getByAltText("第一张图片").getAttribute("src")).toBe(
        "/api/catalog-media-thumbnail?fixture=file/one.webp",
      ),
    );
    const request = new URL(
      runtime.fetch.mock.calls[0]![0] as string,
      window.location.origin,
    );
    expect(request.searchParams.get("where[catalogId][equals]")).toBe(
      "synthetic-catalog",
    );
    expect(request.searchParams.get("where[mediaId][in][1]")).toBe(
      "synthetic-image-two",
    );
    expect(runtime.fetch.mock.calls[0]![1]).toMatchObject({
      credentials: "include",
      cache: "no-store",
      redirect: "error",
    });
    expect(document.querySelector("img[src*=must-not-be-used]")).toBeNull();
  });

  it("changes only representative flags or ordering fields, preserving original media evidence", async () => {
    const original = structuredClone(runtime.fields);
    render(createElement(Picker));
    await screen.findByAltText("第二张图片");
    fireEvent.click(
      screen.getByRole("button", { name: "设为代表图：第二张图片" }),
    );
    expect(runtime.dispatchFields).toHaveBeenLastCalledWith({
      type: "UPDATE_MANY",
      formState: {
        "media.0.isRepresentative": { value: false, valid: true },
        "media.1.isRepresentative": { value: true, valid: true },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /同步图片顺序/ }));
    expect(runtime.dispatchFields).toHaveBeenLastCalledWith({
      type: "UPDATE_MANY",
      formState: {
        "media.0.position": { value: 0, valid: true },
        "media.1.position": { value: 1, valid: true },
      },
    });
    expect(runtime.fields).toEqual(original);
    expect(runtime.setModified).toHaveBeenCalledWith(true);
  });

  it("attaches a selected native image at the existing catalogs.media schema path", async () => {
    render(createElement(Picker));
    await screen.findByAltText("第一张图片");
    runtime.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        mediaId: "synthetic-image-three",
        catalogId: "synthetic-catalog",
        objectKey: "synthetic/three.webp",
        width: 300,
        height: 400,
        alt: "第三张图片",
        rights: "原始声明",
        orderConfidence: "LOW",
      }),
    });
    runtime.select?.({ doc: { id: 3 } });
    await waitFor(() => expect(runtime.addFieldRow).toHaveBeenCalled());
    expect(runtime.addFieldRow.mock.calls[0]![0]).toMatchObject({
      path: "media",
      schemaPath: "catalogs.media",
      subFieldState: {
        position: { value: 8 },
        isRepresentative: { value: false },
        rights: { value: "原始声明" },
        orderConfidence: { value: "LOW" },
      },
    });
  });

  it("keeps editing available when previews fail and still requires a saved Catalog before upload", async () => {
    runtime.catalogDocumentId = undefined;
    runtime.fetch.mockRejectedValue(new Error("unavailable"));
    render(createElement(Picker));
    await screen.findByText("图片预览暂不可用，可继续编辑下方图片信息。");
    expect(
      screen.getByRole("button", { name: /上传原图/ }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: /同步图片顺序/ })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});

it("replaces a failed thumbnail with a placeholder and keeps image controls usable", async () => {
  render(createElement(Picker));
  const image = await screen.findByAltText("第一张图片");
  fireEvent.error(image);
  expect(screen.queryByAltText("第一张图片")).toBeNull();
  expect(screen.getByLabelText("图片预览暂不可用")).toBeTruthy();
  expect(
    screen.getByText("图片预览暂不可用，可继续编辑下方图片信息。"),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: /同步图片顺序/ })
      .hasAttribute("disabled"),
  ).toBe(false);
  expect(document.querySelector('img[src*="/api/media/file/"]')).toBeNull();
});
