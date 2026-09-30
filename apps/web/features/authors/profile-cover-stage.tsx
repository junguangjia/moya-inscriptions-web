"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
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
import presentation from "../user/user-presentation.module.css";
import styles from "./profile-background-editor.module.css";

export const COVER_MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;
export const DEVICE_LABELS: Readonly<Record<CoverDevice, string>> = {
  phone: "手机",
  desktop: "电脑",
};

export interface CoverIdentity {
  readonly name: string;
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
      </span>
    </>
  );
};

/**
 * The crop stage: react-easy-crop (drag, pinch, keyboard) over the 4:3 master
 * with the selected device's header window, the other device's window for
 * reference and the all-device safe area (YouTube-style nested regions).
 */
export const ProfileCoverStage = ({
  image,
  sourceWidth,
  headers,
  thisDevice,
  identity,
  locked,
  onAreaChange,
}: {
  /** Bounded display copy of the chosen photo. */
  image: { readonly url: string };
  /** Oriented width of the chosen photo, for the resolution notice. */
  sourceWidth: number;
  headers: Readonly<Record<CoverDevice, HeaderBox>>;
  thisDevice: CoverDevice;
  identity: CoverIdentity;
  locked: boolean;
  onAreaChange: (area: Area) => void;
}) => {
  const [crop, setCrop] = useState({ x: 0, y: 0 }),
    [zoom, setZoom] = useState(1),
    [device, setDevice] = useState<CoverDevice>(thisDevice),
    [guides, setGuides] = useState(true),
    [surface, setSurface] = useState(0),
    [area, setArea] = useState<Area | null>(null),
    [coarse, setCoarse] = useState(false);
  const interacting = useRef(false),
    latestLocked = useRef(locked);
  latestLocked.current = locked;
  const hintId = useId();
  const other: CoverDevice = device === "phone" ? "desktop" : "phone";
  useEffect(() => {
    setCoarse(window.matchMedia?.("(pointer: coarse)").matches ?? false);
  }, []);
  // react-easy-crop keeps document listeners until touchend or mouseup. A
  // cancelled touch (system gesture, call) or a lost mouseup would leave the
  // next touch dragging: end it by remounting; crop and zoom stay controlled.
  const endInterrupted = () => {
    if (!interacting.current) return;
    interacting.current = false;
    setSurface((value) => value + 1);
  };
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") endInterrupted();
    };
    window.addEventListener("blur", endInterrupted);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", endInterrupted);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  const changeZoom = (value: number) => {
    if (latestLocked.current) return;
    setZoom(Math.min(COVER_MAX_ZOOM, Math.max(1, value)));
  };
  const reset = () => {
    if (latestLocked.current) return;
    setCrop({ x: 0, y: 0 });
    setZoom(1);
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === "+" || event.key === "=") changeZoom(zoom + ZOOM_STEP);
    else if (event.key === "-" || event.key === "_")
      changeZoom(zoom - ZOOM_STEP);
    else if (event.key === "0") reset();
    else return;
    event.preventDefault();
  };
  const selected = headers[device],
    shown = coverWindow(selected.width / selected.height),
    reference = coverWindow(headers[other].width / headers[other].height);
  return (
    <div className={styles.stage} onKeyDown={keys}>
      <div className={styles.stageView}>
        <div className={styles.toolbar}>
          <div className={styles.segmented} role="group" aria-label="预览设备">
            {(["phone", "desktop"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={device === value}
                onClick={() => setDevice(value)}
              >
                {DEVICE_LABELS[value]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={styles.toggle}
            aria-pressed={guides}
            onClick={() => setGuides((value) => !value)}
          >
            参考线
          </button>
        </div>
        <div
          className={styles.frame}
          data-cover-stage=""
          data-locked={locked}
          onTouchCancel={endInterrupted}
          onContextMenu={(event) => event.preventDefault()}
        >
          <Cropper
            key={surface}
            image={image.url}
            crop={crop}
            zoom={zoom}
            aspect={COVER_ASPECT}
            objectFit="cover"
            minZoom={1}
            maxZoom={COVER_MAX_ZOOM}
            showGrid={false}
            keyboardStep={8}
            disableAutomaticStylesInjection
            classes={{ cropAreaClassName: styles.cropArea ?? "" }}
            cropperProps={{
              tabIndex: locked ? -1 : 0,
              "aria-label": "拖动照片调整主页背景，可用方向键移动",
              "aria-describedby": hintId,
            }}
            mediaProps={{ alt: "待裁剪的主页背景", draggable: false }}
            onCropChange={(value) => {
              if (!latestLocked.current) setCrop(value);
            }}
            onZoomChange={(value) => {
              if (!latestLocked.current) setZoom(value);
            }}
            onTouchRequest={() => !latestLocked.current}
            // Plain wheel and two-finger scroll keep scrolling the dialog;
            // trackpad pinch arrives with ctrlKey (Safari uses gesture events).
            onWheelRequest={(event) => !latestLocked.current && event.ctrlKey}
            onInteractionStart={() => {
              interacting.current = true;
            }}
            onInteractionEnd={() => {
              interacting.current = false;
            }}
            onCropAreaChange={(value) => {
              if (latestLocked.current) return;
              setArea(value);
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
        {guides && (
          <p className={styles.legend}>
            <span>
              <i className={styles.legendDim} />
              {DEVICE_LABELS[device]}上看不到
            </span>
            <span>
              <i className={styles.legendReference} />
              {DEVICE_LABELS[other]}显示范围（参考）
            </span>
            <span>
              <i className={styles.legendSafe} />
              重要内容放在框内
            </span>
          </p>
        )}
      </div>
      <div className={styles.stageControls}>
        <div className={styles.zoom}>
          <button
            type="button"
            aria-label="缩小"
            disabled={locked || zoom <= 1}
            onClick={() => changeZoom(zoom - ZOOM_STEP)}
          >
            −
          </button>
          <input
            aria-label="缩放"
            aria-valuetext={`${Math.round(zoom * 100)}%`}
            type="range"
            min="1"
            max={COVER_MAX_ZOOM}
            step="0.01"
            value={zoom}
            disabled={locked}
            onChange={(event) => changeZoom(Number(event.target.value))}
          />
          <button
            type="button"
            aria-label="放大"
            disabled={locked || zoom >= COVER_MAX_ZOOM}
            onClick={() => changeZoom(zoom + ZOOM_STEP)}
          >
            +
          </button>
          <button
            type="button"
            className={styles.reset}
            disabled={locked || (zoom === 1 && crop.x === 0 && crop.y === 0)}
            onClick={reset}
          >
            重置
          </button>
        </div>
        <p id={hintId} className={styles.hint}>
          {coarse
            ? "拖动照片调整位置，双指缩放。"
            : "拖动照片调整位置，触控板双指捏合或按住 Ctrl 滚动缩放，也可使用 + − 键。"}
        </p>
        {zoom >= COVER_MAX_ZOOM && (
          <p className={styles.notice}>已放大到最大</p>
        )}
        {area && isLowResolution(area, sourceWidth) && (
          <p className={styles.notice}>
            照片分辨率较低，在电脑大屏上可能不够清晰
          </p>
        )}
      </div>
    </div>
  );
};
