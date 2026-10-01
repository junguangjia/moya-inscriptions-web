"use client";
import { spacing, typography } from "@moya/design-tokens";
import { StudioName } from "./user-identity";
import { useId, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import Cropper from "react-easy-crop";
import type { Area } from "react-easy-crop";
import "react-easy-crop/react-easy-crop.css";
import {
  COVER_ASPECT,
  COVER_SAFE_RECT,
  coverWindow,
  guidesFor,
  isLowResolution,
} from "./profile-cover";
import type { CoverDevice, CoverRect, HeaderBox } from "./profile-cover";
import { CROP_MAX_ZOOM, useCropGestures } from "./crop-gestures";
import { CropTools } from "./crop-tools";
import { EditorSwitch } from "../publishing/ui/editor/mode-switches";
import editor from "../publishing/ui/editor/editor.module.css";
import media from "../publishing/ui/media/media.module.css";
import presentation from "../user/user-presentation.module.css";
import styles from "./profile-background-editor.module.css";

const DEVICES = ["phone", "desktop"] as const;
export const DEVICE_LABELS: Readonly<Record<CoverDevice, string>> = {
  phone: "手机",
  desktop: "电脑",
};

export interface CoverIdentity {
  readonly name: string;
  readonly studioName?: string | undefined;
  readonly avatarSrc: string | null;
}

const box = (rect: CoverRect): CSSProperties => ({
  left: `${rect.x * 100}%`,
  top: `${rect.y * 100}%`,
  width: `${rect.width * 100}%`,
  height: `${rect.height * 100}%`,
});

/**
 * The owner's header drawn over a region of the master or of a replica: the
 * live cover fade, the avatar and name where the header places them, and the
 * owner-only pencil. Positions are fractions of the header box.
 */
export const HeaderGhost = ({
  header,
  identity,
  fade = true,
}: {
  header: HeaderBox;
  identity: CoverIdentity;
  /** A replica with the live `.profileCover` already fades its image. */
  fade?: boolean;
}) => {
  const guides = guidesFor(header);
  return (
    <>
      {fade && <span className={`${styles.fade} ${presentation.coverFade}`} />}
      <span className={styles.ghostPencil} style={box(guides.pencil)} />
      <span
        className={styles.ghostAvatar}
        style={{
          top: `${guides.avatarTop * 100}%`,
          width: `${guides.avatarSize * 100}cqw`,
          fontSize: `${guides.avatarSize * 45}cqw`,
        }}
      >
        {identity.avatarSrc ? (
          <img src={identity.avatarSrc} alt="" />
        ) : (
          identity.name.slice(0, 1)
        )}
      </span>
      <span
        className={styles.ghostName}
        style={{
          top: `${guides.nameTop * 100}%`,
          fontSize: `${guides.nameSize * 100}cqw`,
        }}
      >
        {identity.name}
        {identity.studioName && (
          <span
            className={styles.ghostStudio}
            style={
              {
                fontSize: `${(Number.parseFloat(typography.body.mobileSize) / header.width) * 100}cqw`,
                marginTop: `${(Number.parseFloat(spacing[2]) / header.width) * 100}cqw`,
                "--studio-inset": `${(Number.parseFloat(spacing[3]) / header.width) * 100}cqw`,
              } as CSSProperties
            }
          >
            <StudioName value={identity.studioName} prominent />
          </span>
        )}
      </span>
    </>
  );
};

/** 手机 / 电脑 as the 设置 underline tabs (`.phase4-settings-tabs`). */
export const DeviceTabs = ({
  idBase,
  value,
  onChange,
}: {
  idBase: string;
  value: CoverDevice;
  onChange: (value: CoverDevice) => void;
}) => (
  <div
    className={`phase4-settings-tabs ${styles.deviceTabs}`}
    role="tablist"
    aria-label="预览设备"
  >
    {DEVICES.map((device, index) => (
      <button
        key={device}
        type="button"
        role="tab"
        id={`${idBase}-${device}`}
        aria-controls={`${idBase}-panel`}
        aria-selected={value === device}
        tabIndex={value === device ? 0 : -1}
        onClick={() => onChange(device)}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const next =
            event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
          onChange(DEVICES[next]!);
          const tabs =
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
              "button",
            );
          tabs?.[next]?.focus();
        }}
      >
        {DEVICE_LABELS[device]}
      </button>
    ))}
  </div>
);

/**
 * The crop stage: react-easy-crop (drag, two-finger zoom, keyboard) over the
 * 4:3 master with the selected device's header window, the other device's
 * window for reference and the all-device safe area (YouTube-style nested
 * regions), laid out like the publishing crop dialog.
 */
export const ProfileCoverStage = ({
  image,
  sourceWidth,
  headers,
  thisDevice,
  identity,
  locked,
  autoFocus = false,
  onAreaChange,
  children,
}: {
  /** Bounded display copy of the chosen photo. */
  image: { readonly url: string };
  /** Width of the decoded (bounded) photo the export draws from, for the resolution notice. */
  sourceWidth: number;
  headers: Readonly<Record<CoverDevice, HeaderBox>>;
  thisDevice: CoverDevice;
  identity: CoverIdentity;
  locked: boolean;
  /** Focus the crop area once the photo is laid out. */
  autoFocus?: boolean;
  onAreaChange: (area: Area) => void;
  /** The editor's action row, placed under the tools and the 参考线 switch. */
  children?: ReactNode;
}) => {
  const gestures = useCropGestures({ locked, autoFocus });
  const [device, setDevice] = useState<CoverDevice>(thisDevice),
    [guides, setGuides] = useState(true);
  const idBase = useId(),
    hintId = useId();
  const other: CoverDevice = device === "phone" ? "desktop" : "phone";
  const selected = headers[device],
    shown = coverWindow(selected.width / selected.height),
    reference = coverWindow(headers[other].width / headers[other].height);
  return (
    <div className={styles.stage} {...gestures.wrapperProps}>
      <div className={styles.stageView}>
        <DeviceTabs idBase={idBase} value={device} onChange={setDevice} />
        <div
          className={styles.frame}
          data-cover-stage=""
          data-locked={locked}
          role="tabpanel"
          id={`${idBase}-panel`}
          aria-labelledby={`${idBase}-${device}`}
          {...gestures.frameProps}
        >
          <Cropper
            key={gestures.surface}
            image={image.url}
            {...gestures.cropperProps}
            aspect={COVER_ASPECT}
            objectFit="cover"
            showGrid={false}
            disableAutomaticStylesInjection
            classes={{ cropAreaClassName: styles.cropArea ?? "" }}
            cropperProps={{
              tabIndex: locked ? -1 : 0,
              "aria-label":
                "拖动照片调整主页背景，方向键移动，+ − 键缩放，0 键还原",
              "aria-describedby": hintId,
            }}
            mediaProps={{ alt: "待裁剪的主页背景", draggable: false }}
            onCropAreaChange={(value) => {
              gestures.reportArea(value);
              onAreaChange(value);
            }}
          />
          {guides && (
            <div className={styles.overlay} aria-hidden="true">
              <div
                className={styles.window}
                data-cover-window={device}
                style={box(shown)}
              >
                <HeaderGhost header={selected} identity={identity} />
              </div>
              <div
                className={styles.reference}
                data-cover-reference={other}
                style={box(reference)}
              />
              <div
                className={styles.safe}
                data-cover-safe=""
                style={box(COVER_SAFE_RECT)}
              />
            </div>
          )}
        </div>
      </div>
      <div className={styles.stageControls}>
        <CropTools
          hintId={hintId}
          coarse={gestures.coarse}
          pristine={gestures.pristine}
          locked={locked}
          onReset={gestures.reset}
        />
        <div className={editor.switches}>
          <EditorSwitch
            name="cover-guides"
            label="参考线"
            description={`亮处为${DEVICE_LABELS[device]}显示范围，虚线为${DEVICE_LABELS[other]}显示范围；重要内容请放在顶部小框内。`}
            checked={guides}
            onChange={setGuides}
          />
        </div>
        {children}
        {gestures.zoom >= CROP_MAX_ZOOM && (
          <p role="status" className={media.dialogNote}>
            已放大到最大
          </p>
        )}
        {gestures.area && isLowResolution(gestures.area, sourceWidth) && (
          <p role="status" className={media.notice}>
            照片分辨率较低，在电脑大屏上可能不够清晰
          </p>
        )}
      </div>
    </div>
  );
};
