"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
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
  /** The editor's actions, placed right under the frame and legend. */
  children?: ReactNode;
}) => {
  const [crop, setCrop] = useState({ x: 0, y: 0 }),
    [zoom, setZoom] = useState(1),
    [device, setDevice] = useState<CoverDevice>(thisDevice),
    [guides, setGuides] = useState(true),
    [surface, setSurface] = useState(0),
    [area, setArea] = useState<Area | null>(null),
    [coarse, setCoarse] = useState(false);
  const frame = useRef<HTMLDivElement>(null),
    focused = useRef(false),
    interacting = useRef(false),
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
    // A second finger landing outside the frame starts no pinch in the
    // library (its distance stays 0, so zoom would jump): end the gesture.
    const outside = (event: TouchEvent) => {
      if (
        frame.current &&
        event.target instanceof Node &&
        !frame.current.contains(event.target)
      )
        endInterrupted();
    };
    window.addEventListener("blur", endInterrupted);
    document.addEventListener("visibilitychange", hidden);
    document.addEventListener("touchstart", outside, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("blur", endInterrupted);
      document.removeEventListener("visibilitychange", hidden);
      document.removeEventListener("touchstart", outside, { capture: true });
    };
  }, []);
  // The crop area exists once the library has measured and reported an
  // area: focus it then, once per stage (keyboard and screen readers).
  useEffect(() => {
    if (!autoFocus || focused.current || !area) return;
    const target = frame.current?.querySelector<HTMLElement>('[tabindex="0"]');
    if (!target) return;
    focused.current = true;
    target.focus({ preventScroll: true });
  }, [area, autoFocus]);
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
    // Only the photo takes + − 0 (not the toolbar or the action buttons);
    // browser shortcuts (page zoom Ctrl/⌘ + = − 0) stay the browser's.
    if (
      latestLocked.current ||
      !(
        event.target instanceof Node && frame.current?.contains(event.target)
      ) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
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
  // While saving, the arrow keys of an already focused crop area must not
  // move the photo; layout re-reports (rotation, resize) still apply.
  const lockKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.key.startsWith("Arrow")) return;
    // ⌘/Alt/Ctrl + arrows are the browser's (Back, page scroll): the
    // library would otherwise take them as an 8 px nudge.
    if (event.ctrlKey || event.metaKey || event.altKey) {
      event.stopPropagation();
      return;
    }
    if (latestLocked.current) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  return (
    <div className={styles.stage} onKeyDown={keys} onKeyDownCapture={lockKeys}>
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
          <div className={styles.toolbarEnd}>
            <button
              type="button"
              className={styles.toggle}
              disabled={locked}
              aria-disabled={zoom === 1 && crop.x === 0 && crop.y === 0}
              onClick={reset}
            >
              重置
            </button>
            <button
              type="button"
              className={styles.toggle}
              aria-pressed={guides}
              onClick={() => setGuides((value) => !value)}
            >
              参考线
            </button>
          </div>
        </div>
        <div
          ref={frame}
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
              "aria-label":
                "拖动照片调整主页背景，方向键移动，+ − 键缩放，0 键重置",
              "aria-keyshortcuts": "+ - 0",
              "aria-describedby": hintId,
            }}
            mediaProps={{ alt: "待裁剪的主页背景", draggable: false }}
            // User input is blocked while saving (touch, wheel, keys and
            // pointer-events); what still arrives is layout re-reporting.
            onCropChange={setCrop}
            onZoomChange={setZoom}
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
        {children}
        <p id={hintId} className={styles.hint}>
          {coarse
            ? "拖动照片调整位置，双指缩放。"
            : "拖动照片调整位置，触控板双指缩放（也可按住 Ctrl 滚动）。"}
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
