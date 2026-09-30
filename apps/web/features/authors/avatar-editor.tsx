"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AuthorProfile } from "@moya/contracts";
import Cropper from "react-easy-crop";
import type { Area } from "react-easy-crop";
import "react-easy-crop/react-easy-crop.css";
import { AuthorDialog } from "./author-dialog";
import { useAuthors } from "./author-context";
import { readAvatarImage, exportAvatarSnapshot } from "./avatar-image";
import { useCropGestures } from "./crop-gestures";
import { CropTools } from "./crop-tools";
import media from "../publishing/ui/media/media.module.css";
import type { AvatarImage } from "./avatar-image";
import styles from "./avatar-editor.module.css";
const availableAt = (next: string | null) =>
  next ? new Date(next).getTime() : 0;
const newYorkTime = (next: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(next));

/** The device picker runs directly from the owner's click, before opening a modal. */
export const AvatarEntry = ({
  profile,
  className,
  children,
}: {
  profile: AuthorProfile;
  className: string | undefined;
  children: ReactNode;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [open, setOpen] = useState(false);
  const author = useAuthors();
  if (!profile.isOwner || author.viewer?.id !== profile.id)
    return <div className={className}>{children}</div>;
  return (
    <>
      <button
        type="button"
        className={`${className} ${styles.entry}`}
        aria-label="更换头像"
        disabled={Boolean(author.avatarSave && !author.avatarSave.failed)}
        onClick={() =>
          availableAt(profile.nextAvatarChangeAt) > Date.now()
            ? setOpen(true)
            : input.current?.click()
        }
      >
        {children}
        <span className={styles.entryLabel}>更换头像</span>
      </button>
      <input
        ref={input}
        hidden
        type="file"
        accept="image/jpeg,image/png,image/webp"
        aria-label="选择头像照片"
        onChange={(event) => {
          const selected = event.target.files?.[0];
          event.target.value = "";
          if (selected) {
            setFile(selected);
            setOpen(true);
          }
        }}
      />
      {open && (
        <AvatarEditor
          profile={profile}
          file={file}
          onClose={() => {
            setOpen(false);
            setFile(null);
          }}
        />
      )}
    </>
  );
};

export const AvatarEditor = ({
  profile,
  file: initialFile = null,
  onClose,
}: {
  profile: AuthorProfile;
  file?: File | null;
  onClose: () => void;
}) => {
  const [file, setFile] = useState(initialFile);
  const [source, setSource] = useState<AvatarImage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const ownedSource = useRef<AvatarImage | null>(null);
  const next = profile.nextAvatarChangeAt;
  const [now, setNow] = useState(Date.now);
  const input = useRef<HTMLInputElement>(null);
  const cropArea = useRef<Area | null>(null);
  const saving = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (ownedSource.current) URL.revokeObjectURL(ownedSource.current.url);
    };
  }, []);
  const author = useAuthors();
  // Owner decision (#171 r4): the same two-finger zoom as the cover editor,
  // with no zoom slider.
  const gestures = useCropGestures({ locked: busy });
  const hintId = useId();
  const limited = availableAt(next) > now;
  useEffect(() => {
    if (!limited) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(availableAt(next) - Date.now() + 10, 2147483647),
    );
    return () => window.clearTimeout(timer);
  }, [next, limited]);
  useEffect(() => {
    let active = true;
    if (!file) return;
    setDecoding(true);
    setError("");
    void readAvatarImage(file)
      .then((value) => {
        if (!active) {
          URL.revokeObjectURL(value.url);
          return;
        }
        if (ownedSource.current) URL.revokeObjectURL(ownedSource.current.url);
        ownedSource.current = value;
        cropArea.current = null;
        setReady(false);
        gestures.reset();
        setSource(value);
      })
      .catch((e) => {
        if (active)
          setError(e instanceof Error ? e.message : "图像无法打开，请重新选择");
      })
      .finally(() => {
        if (active) setDecoding(false);
      });
    return () => {
      active = false;
    };
  }, [file]);
  const save = () => {
    if (
      saving.current ||
      decoding ||
      limited ||
      author.checking ||
      author.sessionError ||
      !source ||
      !cropArea.current
    )
      return;
    saving.current = true;
    setError("");
    try {
      // No await before the durable intent: Back/reload cannot discard this save.
      const snapshot = exportAvatarSnapshot(source.image, {
        ...cropArea.current,
      });
      author.saveAvatar(snapshot);
      setBusy(true);
      onClose();
    } catch (e) {
      saving.current = false;
      setError(e instanceof Error ? e.message : "头像尚未开始保存，请重试");
    }
  };
  // Owner acceptance (2026-09-26): deciding not to change the avatar is just
  // Back (header or swipe), with no discard prompt; a crop is quick to redo.
  return (
    <AuthorDialog title="更换头像" onClose={onClose}>
      <div
        className={`${media.dialogBody} ${styles.editor}`}
        aria-busy={busy}
        {...gestures.wrapperProps}
      >
        {source && (
          <div
            className={styles.viewport}
            data-avatar-crop=""
            data-saving={busy}
            {...gestures.frameProps}
          >
            <Cropper
              key={`${source.url}:${gestures.surface}`}
              image={source.url}
              {...gestures.cropperProps}
              aspect={1}
              cropShape="round"
              showGrid={false}
              objectFit="cover"
              disableAutomaticStylesInjection
              classes={{ cropAreaClassName: styles.mask ?? "" }}
              cropperProps={{
                tabIndex: busy ? -1 : 0,
                "aria-label":
                  "拖动照片调整头像，方向键移动，+ − 键缩放，0 键还原",
                "aria-describedby": hintId,
              }}
              mediaProps={{ alt: "待裁剪的头像照片", draggable: false }}
              onCropAreaChange={(percent, area) => {
                gestures.reportArea(percent);
                if (saving.current) return;
                cropArea.current = area;
                setReady(true);
              }}
            />
          </div>
        )}
        {source ? (
          <CropTools
            hintId={hintId}
            coarse={gestures.coarse}
            pristine={gestures.pristine}
            locked={busy}
            onReset={gestures.reset}
          />
        ) : (
          <p className={media.dialogNote}>
            {file && !error ? "正在打开照片…" : "选择照片，调整你的头像。"}
          </p>
        )}
        <p className={media.dialogNote}>
          {limited && next
            ? `今天已更换过头像。下次可更换：${newYorkTime(next)}（美国纽约时间）。`
            : "每天可更换一次头像，以美国纽约日期为准。"}
        </p>
        <input
          hidden
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label="重新选择头像照片"
          disabled={busy || limited}
          onChange={(event) => {
            const selected = event.target.files?.[0];
            event.target.value = "";
            if (selected && !saving.current) setFile(selected);
          }}
        />
        {author.checking && !busy && (
          <p role="status" className={media.dialogNote}>
            正在确认账户…
          </p>
        )}
        {author.sessionError && (
          <div className={media.notice} role="alert">
            <p className={media.errorText}>
              暂时无法确认账户，裁剪已保留。请检查网络后重试。
            </p>
            <button
              type="button"
              className={media.secondaryButton}
              disabled={author.checking || busy}
              onClick={() => void author.refresh()}
            >
              重新确认账户
            </button>
          </div>
        )}
        {error && !author.sessionError && (
          <p role="alert" className={media.errorText}>
            {error}
          </p>
        )}
        <div className={media.dialogActions}>
          <button
            type="button"
            className={media.secondaryButton}
            disabled={busy || limited}
            onClick={() => input.current?.click()}
          >
            重新选择
          </button>
          <button
            type="button"
            className={media.primaryButton}
            disabled={
              !ready ||
              decoding ||
              busy ||
              limited ||
              author.checking ||
              author.sessionError
            }
            onClick={save}
          >
            {busy ? "正在保存…" : "保存头像"}
          </button>
        </div>
      </div>
    </AuthorDialog>
  );
};
