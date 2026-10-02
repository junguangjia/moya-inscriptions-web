"use client";

import { useState } from "react";
import type { MediaCrop } from "@moya/contracts";
import type { DetailMediaPresentation } from "../../detail/catalog-detail-presentation";
import { EditorDialog } from "../../publishing/ui/editor/editor-dialog";
import { PresetPicker } from "../../publishing/ui/media/crop-workspace";
import {
  centeredCrop,
  EDIT_PRESETS,
  matchPreset,
  normalizeCrop,
  presetRatio,
} from "../../publishing/ui/media/media-geometry";
import { ArticleFreeCrop } from "./article-free-crop";
import styles from "./article-authoring.module.css";

export const ArticleImageCropDialog = ({
  media,
  crop,
  onApply,
  onCancel,
}: {
  readonly media: DetailMediaPresentation;
  readonly crop: MediaCrop | null;
  readonly onApply: (crop: MediaCrop | null) => boolean;
  readonly onCancel: () => void;
}) => {
  const [draft, setDraft] = useState(() => normalizeCrop(crop));
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState(false);
  return (
    <EditorDialog
      title="裁剪范围"
      description="直接调整正文中的显示范围；原图保持完整。"
      size="wide"
      dataName="article-image-crop"
      onCancel={onCancel}
    >
      <ArticleFreeCrop
        key={generation}
        media={media}
        crop={draft}
        onChange={setDraft}
      />
      <PresetPicker
        name="article-image-aspect"
        presets={EDIT_PRESETS}
        value={matchPreset(draft, media) ?? "custom"}
        onChange={(value) => {
          const preset = EDIT_PRESETS.find((item) => item.id === value);
          if (!preset) return;
          setDraft(centeredCrop(presetRatio(preset, media), media));
          setGeneration((current) => current + 1);
        }}
      />
      {error ? (
        <p role="alert" className={styles.fieldError}>
          图片或账号状态已改变，请取消后重新打开。
        </p>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          onClick={() => {
            setDraft(null);
            setGeneration((current) => current + 1);
          }}
        >
          恢复完整图片
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className={styles.primary}
          onClick={() => {
            if (onApply(draft)) onCancel();
            else setError(true);
          }}
        >
          应用裁剪
        </button>
      </div>
    </EditorDialog>
  );
};
