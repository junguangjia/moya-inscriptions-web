"use client";

import { useEffect, useState } from "react";
import {
  Button,
  useConfig,
  useDocumentDrawer,
  useDocumentInfo,
  useField,
  useForm,
  useFormFields,
  useListDrawer,
} from "@payloadcms/ui";
import type { FormState, UIFieldClientComponent } from "payload";
import type { EditorialMedia } from "@moya/contracts/internal/editorial";
import { selectedMediaSnapshot } from "./snapshot";

type MediaPreview = { mediaId: string; url: string };

/** Native media responses resolve their own URLs; never derive one from storage keys. */
const nativePreview = (
  document: Record<string, unknown>,
): MediaPreview | null => {
  if (typeof document.mediaId !== "string" || typeof document.url !== "string")
    return null;
  try {
    const url = new URL(document.url, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return { mediaId: document.mediaId, url: `${url.pathname}${url.search}` };
  } catch {
    return null;
  }
};

export const MediaSnapshotPicker: UIFieldClientComponent = () => {
  const { config } = useConfig();
  const { id: catalogDocumentId } = useDocumentInfo();
  const { value: catalogId } = useField<string>({ path: "catalogId" });
  const { addFieldRow, getDataByPath, getFields, dispatchFields, setModified } =
    useForm();
  const fields = useFormFields(([current]) => current);
  const mediaRows = fields.media?.rows;
  const pictures = (mediaRows ?? []).map((row, index) => ({
    id: row.id,
    index,
    mediaId: String(fields[`media.${index}.mediaId`]?.value ?? ""),
    alt: String(fields[`media.${index}.alt`]?.value ?? ""),
    representative: fields[`media.${index}.isRepresentative`]?.value === true,
  }));
  const mediaIdentity = JSON.stringify(
    pictures.map((picture) => picture.mediaId),
  );
  const [previews, setPreviews] = useState<MediaPreview[]>([]);
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ListDrawer, , { openDrawer: openList, closeDrawer: closeList }] =
    useListDrawer({
      collectionSlugs: ["media"],
      selectedCollection: "media",
      uploads: true,
      filterOptions: {
        media: catalogId ? { catalogId: { equals: catalogId } } : false,
      },
    });
  const [UploadDrawer, , { openDrawer: openUpload, closeDrawer: closeUpload }] =
    useDocumentDrawer({ collectionSlug: "media" });

  useEffect(() => {
    const ids = (JSON.parse(mediaIdentity) as string[]).filter(Boolean);
    const controller = new AbortController();
    setPreviews([]);
    setPreviewUnavailable(false);
    if (!catalogId || ids.length === 0) return () => controller.abort();
    const load = async () => {
      try {
        const batches: string[][] = [];
        for (let index = 0; index < ids.length; index += 100)
          batches.push(ids.slice(index, index + 100));
        const results = await Promise.all(
          batches.map(async (batch) => {
            const query = new URLSearchParams({
              depth: "0",
              limit: String(batch.length),
              "where[catalogId][equals]": catalogId,
            });
            batch.forEach((id, index) =>
              query.set(`where[mediaId][in][${index}]`, id),
            );
            const response = await fetch(
              `${config.routes.api}/media?${query}`,
              {
                credentials: "include",
                cache: "no-store",
                redirect: "error",
                signal: controller.signal,
              },
            );
            if (!response.ok) throw new Error("MEDIA_PREVIEW_UNAVAILABLE");
            const result: unknown = await response.json();
            if (
              !result ||
              typeof result !== "object" ||
              !("docs" in result) ||
              !Array.isArray(result.docs)
            )
              throw new Error("MEDIA_PREVIEW_UNAVAILABLE");
            return result.docs.flatMap((document: unknown) => {
              if (
                !document ||
                typeof document !== "object" ||
                Array.isArray(document)
              )
                return [];
              const preview = nativePreview(
                document as Record<string, unknown>,
              );
              return preview ? [preview] : [];
            });
          }),
        );
        if (!controller.signal.aborted) setPreviews(results.flat());
      } catch {
        if (!controller.signal.aborted) setPreviewUnavailable(true);
      }
    };
    void load();
    return () => controller.abort();
  }, [catalogId, config.routes.api, mediaIdentity]);

  const attach = (document: Record<string, unknown>) => {
    const existing =
      getDataByPath<Partial<EditorialMedia>[] | undefined>("media") ?? [];
    const snapshot = selectedMediaSnapshot(document, catalogId, existing);
    if (!snapshot) {
      setMessage("这张图片已在当前草稿中。");
      return;
    }
    const subFieldState: FormState = Object.fromEntries(
      Object.entries(snapshot).map(([key, value]) => [
        key,
        { value, initialValue: value, valid: true },
      ]),
    );
    addFieldRow({ path: "media", schemaPath: "catalogs.media", subFieldState });
    setMessage(
      snapshot.orderConfidence === "LOW"
        ? "已添加图片。原始顺序待核实，请核对后保存草稿。"
        : "已添加图片，保存草稿后生效。",
    );
  };

  const selectExisting = async (id: unknown) => {
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1 || busy) return;
    setBusy(true);
    try {
      const response = await fetch(
        `${config.routes.api}/media/${String(id)}?depth=0`,
        {
          credentials: "include",
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw new Error("MEDIA_UNAVAILABLE");
      const document: unknown = await response.json();
      if (!document || typeof document !== "object" || Array.isArray(document))
        throw new Error("MEDIA_UNAVAILABLE");
      attach(document as Record<string, unknown>);
      closeList();
    } catch {
      setMessage("未能添加图片。请核对所属资料和必填内容后重试。");
    } finally {
      setBusy(false);
    }
  };

  const synchronizeOrder = () => {
    const values =
      getDataByPath<Partial<EditorialMedia>[] | undefined>("media") ?? [];
    const current = getFields();
    const formState: FormState = {};
    values.forEach((_item, index) => {
      const path = `media.${index}.position`;
      formState[path] = { ...current[path], value: index, valid: true };
    });
    dispatchFields({ type: "UPDATE_MANY", formState });
    setModified(true);
    setMessage(
      "已按当前图片行顺序更新序号；原图、权利说明和排序可信度保持原值。保存草稿后生效。",
    );
  };

  const selectRepresentative = (selectedIndex: number) => {
    const current = getFields();
    const formState: FormState = {};
    pictures.forEach(({ index }) => {
      const path = `media.${index}.isRepresentative`;
      formState[path] = {
        ...current[path],
        value: index === selectedIndex,
        valid: true,
      };
    });
    dispatchFields({ type: "UPDATE_MANY", formState });
    setModified(true);
    setMessage("已选择代表图，保存草稿后生效。");
  };

  return (
    <div className="field-type ui" data-editorial-media-picker="">
      {!catalogDocumentId && <p>请先保存草稿，再添加图片。</p>}
      <div className="editorial-media-toolbar">
        <Button
          type="button"
          buttonStyle="secondary"
          disabled={!catalogId || !catalogDocumentId || busy}
          onClick={openList}
        >
          <span aria-hidden="true">＋</span> 选择已有图片
        </Button>
        <Button
          type="button"
          buttonStyle="secondary"
          disabled={!catalogId || !catalogDocumentId || busy}
          onClick={openUpload}
        >
          <span aria-hidden="true">↑</span> 上传原图
        </Button>
        <Button
          type="button"
          buttonStyle="secondary"
          disabled={!mediaRows?.length || busy}
          onClick={synchronizeOrder}
        >
          <span aria-hidden="true">↕</span> 同步图片顺序
        </Button>
      </div>
      {pictures.length > 0 && (
        <ol className="editorial-media-previews" aria-label="已选图片">
          {pictures.map((picture) => {
            const preview = previews.find(
              (item) => item.mediaId === picture.mediaId,
            );
            return (
              <li className="editorial-media-preview" key={picture.id}>
                {preview ? (
                  <img
                    className="editorial-media-preview__image"
                    src={preview.url}
                    alt={picture.alt}
                    width={120}
                    height={120}
                    loading="lazy"
                  />
                ) : (
                  <span
                    className="editorial-media-preview__placeholder"
                    aria-label="图片预览暂不可用"
                  >
                    ▧
                  </span>
                )}
                <span className="editorial-media-preview__caption">
                  {picture.index + 1}. {picture.alt || "未填写图片说明"}
                </span>
                <button
                  type="button"
                  className="editorial-media-preview__representative"
                  aria-pressed={picture.representative}
                  aria-label={`${picture.representative ? "当前代表图" : "设为代表图"}：${picture.alt || `图片 ${picture.index + 1}`}`}
                  disabled={busy}
                  onClick={() => selectRepresentative(picture.index)}
                >
                  <span aria-hidden="true">
                    {picture.representative ? "★" : "☆"}
                  </span>{" "}
                  代表图
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {previewUnavailable && (
        <p role="status">图片预览暂不可用，可继续编辑下方图片信息。</p>
      )}
      {message && <p role="status">{message}</p>}
      <ListDrawer
        allowCreate={false}
        enableRowSelections={false}
        onSelect={({ doc }) => {
          void selectExisting(doc.id);
        }}
      />
      <UploadDrawer
        initialData={{ catalogId, origin: "upload" }}
        onSave={({ doc }) => {
          try {
            attach(doc);
            closeUpload();
          } catch {
            setMessage(
              "原图已保存到媒体库，但未能关联当前草稿。请核对媒体资料后从媒体库重选。",
            );
          }
        }}
      />
    </div>
  );
};
