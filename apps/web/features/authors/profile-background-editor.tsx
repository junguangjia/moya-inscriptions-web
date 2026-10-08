"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Area } from "react-easy-crop";
import type { AuthorProfile } from "@moya/contracts";
import { AuthorDialog } from "./author-dialog";
import { useAuthors } from "./author-context";
import { authorClient } from "./author-data";
import {
  CoverError,
  REFERENCE_HEADERS,
  coverErrorMessage,
  deviceForWidth,
  exportProfileCover,
  needsFreshIntent,
  readProfileCoverImage,
  sameCoverArea,
} from "./profile-cover";
import type {
  CoverDevice,
  CoverExport,
  CoverSavePhase,
  CoverSource,
  HeaderBox,
} from "./profile-cover";
import {
  DEVICE_LABELS,
  DeviceTabs,
  ProfileCoverStage,
} from "./profile-cover-stage";
import { ProfileCoverPreview } from "./profile-cover-preview";
import { requestIdentity } from "../shell/request-identity";
import editor from "../publishing/ui/editor/editor.module.css";
import media from "../publishing/ui/media/media.module.css";
import presentation from "../user/user-presentation.module.css";
import styles from "./profile-background-editor.module.css";

type Step = "overview" | "crop" | "remove";
type Phase = "idle" | "export" | "upload" | "bind" | "refresh" | "done";
const BUSY: readonly Phase[] = ["export", "upload", "bind", "refresh"];
const SAVE_STEPS = [
  ["export", "处理图片"],
  ["upload", "上传"],
  ["bind", "保存"],
  ["refresh", "更新主页"],
] as const;
const PHASE_STATUS: Partial<Record<Phase, string>> = {
  export: "正在处理图片…",
  upload: "正在上传…",
  bind: "正在保存…",
  refresh: "正在更新主页…",
};
/** The unchanged client request budget; after it the header catches up on reload. */
const REFRESH_TIMEOUT_MS = 15_000;

interface Chosen {
  readonly key: number;
  readonly source: CoverSource;
}
/** Upload and save identities pinned to one exported image (or to removal). */
interface Intent {
  readonly result: CoverExport | null;
  readonly uploadId: string;
  readonly saveId: string;
  mediaId?: string | null;
}

const sameBox = (a: HeaderBox, b: HeaderBox) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * The owning header as laid out with a photo, measured beneath the dialog. A
 * header without one is compact, so it is measured for that one synchronous
 * read with the cover geometry flag (nothing paints in between).
 */
const readHeaderBox = (element: HTMLElement): HeaderBox | null => {
  // The photo is a layer of the profile root beside this header (#237).
  const bare = !(element.parentElement ?? element).querySelector(
    `:scope > .${presentation.profileCover} img`,
  );
  if (bare) element.setAttribute("data-cover-measure", "");
  try {
    const rect = element.getBoundingClientRect();
    const avatar = element.querySelector(`.${presentation.avatar}`),
      panel = element.querySelector(`.${presentation.coverIdentity}`),
      name = element.querySelector("h1");
    if (!(rect.width > 0 && rect.height > 0) || !avatar || !panel || !name)
      return null;
    const at = (box: DOMRect) => ({
      x: box.left - rect.left,
      y: box.top - rect.top,
      width: box.width,
      height: box.height,
    });
    const face = at(avatar.getBoundingClientRect()),
      line = at(name.getBoundingClientRect());
    // The top bar overlaps the cover's top edge at rest; measure its icons
    // against the bar so a scrolled page reports the same place.
    const bar = element.parentElement?.querySelector(":scope > header");
    const barTop = bar?.getBoundingClientRect().top ?? rect.top;
    const controls = [
      ...[...(bar?.querySelectorAll("button") ?? [])].map((button) => {
        const box = button.getBoundingClientRect();
        return {
          x: box.left - rect.left,
          y: box.top - barTop,
          width: box.width,
          height: box.height,
        };
      }),
      ...[...element.querySelectorAll(`.${presentation.backgroundEdit}`)].map(
        (button) => at(button.getBoundingClientRect()),
      ),
    ].filter(
      (box) =>
        box.width > 0 &&
        box.x < rect.width &&
        box.x + box.width > 0 &&
        box.y < rect.height,
    );
    return {
      width: rect.width,
      height: rect.height,
      panelTop: panel.getBoundingClientRect().top - rect.top,
      avatar: { x: face.x, y: face.y, size: face.width },
      name: {
        x: line.x,
        y: line.y,
        size: Number.parseFloat(getComputedStyle(name).fontSize) || 24,
      },
      controls,
    };
  } finally {
    if (bare) element.removeAttribute("data-cover-measure");
  }
};

/** The owning header's box, measured while it is laid out beneath the dialog. */
const useHeaderBox = (
  header: RefObject<HTMLElement | null> | undefined,
): HeaderBox | null => {
  const [box, setBox] = useState<HeaderBox | null>(null);
  useEffect(() => {
    const element = header?.current;
    if (!element) return;
    const read = () => {
      const next = readHeaderBox(element);
      if (next) setBox((old) => (old && sameBox(old, next) ? old : next));
    };
    read();
    // The photo geometry follows the viewport even while a compact header
    // does not, and the top-bar icons move against a width-capped cover.
    window.addEventListener("resize", read);
    if (typeof ResizeObserver !== "function")
      return () => window.removeEventListener("resize", read);
    // The cover keeps its height while the identity grows inside it.
    const observer = new ResizeObserver(read);
    observer.observe(element, { box: "border-box" });
    const panel = element.querySelector(`.${presentation.coverIdentity}`);
    if (panel) observer.observe(panel);
    return () => {
      window.removeEventListener("resize", read);
      observer.disconnect();
    };
  }, [header]);
  return box;
};

export const ProfileBackgroundEditor = ({
  profile,
  header,
  onClose,
  onSaved,
}: {
  profile: AuthorProfile;
  /** The owning profile's header section, measured for the preview frames. */
  header?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSaved: () => void;
}) => {
  const author = useAuthors();
  const [thisDevice] = useState<CoverDevice>(() =>
    typeof window === "undefined" ? "phone" : deviceForWidth(window.innerWidth),
  );
  const measured = useHeaderBox(header);
  const headers = measured
    ? { ...REFERENCE_HEADERS, [thisDevice]: measured }
    : REFERENCE_HEADERS;
  const tabsId = useId();
  const [step, setStep] = useState<Step>("overview"),
    [device, setDevice] = useState<CoverDevice>(thisDevice),
    [chosen, setChosen] = useState<Chosen | null>(null),
    [areaReady, setAreaReady] = useState(false),
    [decoding, setDecoding] = useState(false),
    [phase, setPhase] = useState<Phase>("idle"),
    [failed, setFailed] = useState(false),
    [error, setError] = useState("");
  const area = useRef<Area | null>(null),
    exported = useRef<{ key: number; area: Area; result: CoverExport } | null>(
      null,
    ),
    intent = useRef<Intent | null>(null),
    owned = useRef<CoverSource | null>(null),
    input = useRef<HTMLInputElement>(null),
    primary = useRef<HTMLButtonElement>(null),
    keepRemove = useRef<HTMLButtonElement>(null),
    shownStep = useRef<Step>("overview"),
    mounted = useRef(false),
    generation = useRef(0),
    saving = useRef(false),
    target = useRef<string | null>(null),
    phaseRef = useRef<Phase>("idle"),
    /** A bind failed without a definite answer from the server. */
    uncertain = useRef(false);
  const busy = BUSY.includes(phase);
  /** A write is in flight: leaving the page could lose it. */
  const writing = phase === "export" || phase === "upload" || phase === "bind";
  const allowed =
    profile.isOwner &&
    author.viewer?.id === profile.id &&
    !author.checking &&
    !author.sessionError;
  const latest = useRef({
    author,
    account: author.viewer?.id,
    profile,
    onSaved,
  });
  latest.current = { author, account: author.viewer?.id, profile, onSaved };
  /**
   * After a bind that got no definite answer: an editor-scoped read (never a
   * page reload, which offline would close the editor). A failed read keeps
   * the question open for the next exit; a confirmed save refreshes the
   * owning profile and says so.
   */
  const checkUncertain = () => {
    if (!uncertain.current || phaseRef.current !== "idle") return;
    const { profile: current } = latest.current;
    const shown = current.background?.id ?? null;
    void authorClient
      .profile(current.id)
      .then((fresh) => {
        if (!uncertain.current) return;
        uncertain.current = false;
        if ((fresh.background?.id ?? null) === shown) return;
        latest.current.onSaved();
        latest.current.author.notify(
          fresh.background ? "主页背景已保存" : "主页背景已移除",
        );
      })
      .catch(() => {});
  };
  const identity = {
    name: profile.displayName,
    studioName: profile.studioName,
    avatarSrc: profile.avatar?.src ?? null,
  };

  const go = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };
  const release = () => {
    owned.current?.release();
    owned.current = null;
    area.current = null;
    exported.current = null;
    intent.current = null;
    setChosen(null);
    setAreaReady(false);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      owned.current?.release();
      // Leaving after an unconfirmed save still checks it (refs only).
      checkUncertain();
      // The save was confirmed but the editor left before the header caught up.
      if (phaseRef.current === "refresh")
        latest.current.author.notify(
          target.current === null ? "主页背景已移除" : "主页背景已保存",
        );
    };
  }, []);

  // Keyboard and screen-reader users follow the step: the crop area focuses
  // itself once laid out; the overview and removal focus their safe action.
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    if (step === "overview") primary.current?.focus({ preventScroll: true });
    if (step === "remove") keepRemove.current?.focus({ preventScroll: true });
  }, [step]);

  const toOverview = () => {
    generation.current++;
    checkUncertain();
    release();
    setDecoding(false);
    setFailed(false);
    setError("");
    setStep("overview");
  };
  const select = async (file: File) => {
    const run = ++generation.current;
    setDecoding(true);
    setError("");
    try {
      const source = await readProfileCoverImage(file);
      if (!mounted.current || run !== generation.current) {
        source.release();
        return;
      }
      release();
      owned.current = source;
      setChosen({ key: run, source });
      setFailed(false);
      setStep("crop");
    } catch (e) {
      // A failed reselect keeps the current photo and crop.
      if (mounted.current && run === generation.current)
        setError(coverErrorMessage(e));
    } finally {
      if (mounted.current && run === generation.current) setDecoding(false);
    }
  };

  const fail = (message: string) => {
    go("idle");
    setFailed(true);
    setError(message);
  };
  const confirm = (media: string | null) => {
    uncertain.current = false;
    target.current = media;
    go("refresh");
    onSaved();
    author.mutate();
  };
  /** Epoch and viewer checks only: a session revalidation is not a switch. */
  const stillCurrent = (epoch: number) =>
    mounted.current &&
    latest.current.account === profile.id &&
    authorClient.accountEpoch() === epoch;
  const interrupted = () => {
    intent.current = null;
    if (!mounted.current) return;
    fail(
      authorClient.account() === null
        ? "暂时无法确认账户，照片和裁剪已保留"
        : "账户已切换，背景尚未更改",
    );
  };

  /** Truthful copy after a failed request, and the right identity for a retry. */
  const onFailure = (
    e: unknown,
    stage: "export" | CoverSavePhase,
    epoch: number,
  ) => {
    if (!mounted.current) return;
    // A lost bind response may hide a committed save; the overview checks
    // it when the owner leaves this step (never a page reload from here).
    if (stage === "bind") uncertain.current = true;
    if (authorClient.accountEpoch() !== epoch) {
      if (stage !== "bind") return interrupted();
      // Same ids are safe to retry: the server replays a committed save.
      return fail(
        "账户状态已变化，无法确认是否已保存，请确认账户后重试（不会重复保存）",
      );
    }
    if (needsFreshIntent(e)) intent.current = null;
    fail(
      coverErrorMessage(
        stage === "export" && !(e instanceof CoverError)
          ? new CoverError("export")
          : e,
        stage === "export" ? undefined : stage,
      ),
    );
  };

  const save = async () => {
    const current = chosen,
      chosenArea = area.current;
    if (saving.current || !allowed || decoding || !current || !chosenArea)
      return;
    saving.current = true;
    setError("");
    setFailed(false);
    const epoch = authorClient.accountEpoch();
    let stage: "export" | CoverSavePhase = "export";
    try {
      let done = exported.current;
      if (
        !done ||
        done.key !== current.key ||
        !sameCoverArea(done.area, chosenArea, current.source.pixels)
      ) {
        go("export");
        const result = await exportProfileCover(current.source, chosenArea);
        done = { key: current.key, area: chosenArea, result };
        exported.current = done;
      }
      if (intent.current?.result !== done.result)
        intent.current = {
          result: done.result,
          uploadId: requestIdentity(),
          saveId: requestIdentity(),
        };
      const pending = intent.current;
      if (!stillCurrent(epoch)) return interrupted();
      if (pending.mediaId === undefined) {
        stage = "upload";
        go("upload");
        const media = await authorClient.upload(
          done.result.blob,
          pending.uploadId,
        );
        if (!stillCurrent(epoch)) return interrupted();
        pending.mediaId = media.id;
      }
      stage = "bind";
      go("bind");
      await authorClient.background({
        requestId: pending.saveId,
        mediaId: pending.mediaId,
      });
      if (mounted.current) confirm(pending.mediaId);
    } catch (e) {
      onFailure(e, stage, epoch);
    } finally {
      saving.current = false;
    }
  };

  const remove = async () => {
    if (saving.current || !allowed) return;
    saving.current = true;
    setError("");
    setFailed(false);
    const epoch = authorClient.accountEpoch();
    try {
      if (intent.current?.mediaId !== null)
        intent.current = {
          result: null,
          uploadId: "",
          saveId: requestIdentity(),
          mediaId: null,
        };
      const pending = intent.current;
      if (!stillCurrent(epoch)) return interrupted();
      go("bind");
      await authorClient.background({
        requestId: pending.saveId,
        mediaId: null,
      });
      if (mounted.current) confirm(null);
    } catch (e) {
      onFailure(e, "bind", epoch);
    } finally {
      saving.current = false;
    }
  };

  // Close only once the owning header shows the confirmed result, so the
  // success notice never sits over the previous background.
  useEffect(() => {
    if (phase !== "refresh") return;
    const timer = window.setTimeout(() => {
      go("done");
      author.notify(
        target.current === null
          ? "主页背景已移除"
          : "主页背景已保存，刷新后显示",
      );
    }, REFRESH_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);
  const shownId = profile.background?.id ?? null,
    shownSrc = profile.background?.src ?? null;
  useEffect(() => {
    if (phase !== "refresh" || shownId !== target.current) return;
    const finish = () => {
      if (phaseRef.current !== "refresh") return;
      go("done");
      author.notify(shownId ? "主页背景已更新" : "主页背景已移除");
    };
    const image =
      header?.current?.parentElement?.querySelector<HTMLImageElement>(
        `:scope > .${presentation.profileCover} img`,
      );
    if (
      !shownSrc ||
      !image ||
      (image.getAttribute("src") === shownSrc &&
        image.complete &&
        image.naturalWidth > 0)
    ) {
      finish();
      return;
    }
    image.addEventListener("load", finish);
    image.addEventListener("error", finish);
    return () => {
      image.removeEventListener("load", finish);
      image.removeEventListener("error", finish);
    };
  }, [phase, shownId, shownSrc]);

  const pick = () => {
    if (!busy) input.current?.click();
  };
  const onBack = (depth: number) => {
    if (depth === 0) toOverview();
  };
  const saveSteps =
    step === "remove"
      ? SAVE_STEPS.filter(([key]) => key !== "upload" && key !== "export")
      : SAVE_STEPS;
  const activeIndex = saveSteps.findIndex(([key]) => key === phase);
  // The composer's step bars; the status line names the phase.
  const progress = busy && (
    <>
      <ol className={editor.stepProgress} aria-hidden="true">
        {saveSteps.map(([key], index) => (
          <li
            key={key}
            data-reached={index <= activeIndex ? "true" : undefined}
          />
        ))}
      </ol>
      <p role="status" className={media.dialogNote}>
        {PHASE_STATUS[phase]}
      </p>
    </>
  );
  const problems = (
    <>
      {!allowed && !author.sessionError && (
        <p role="status" className={media.dialogNote}>
          正在确认账户，确认后可保存背景。
        </p>
      )}
      {author.sessionError && (
        <div className={media.notice} role="alert">
          <p className={media.errorText}>
            暂时无法确认账户，照片和裁剪已保留。请检查网络后重试。
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
      {error && (
        <div className={styles.problem} role="alert">
          <p className={media.errorText}>{error}</p>
          {failed && step === "crop" && (
            <p className={media.dialogNote}>照片和裁剪已保留。</p>
          )}
        </div>
      )}
    </>
  );
  const opening = decoding && (
    <p role="status" className={media.dialogNote}>
      正在打开照片…
    </p>
  );

  return (
    <AuthorDialog
      title={
        step === "crop"
          ? "调整背景"
          : step === "remove"
            ? "移除背景"
            : "主页背景"
      }
      navigationDepth={step === "overview" ? 0 : 1}
      onBack={onBack}
      dirty={writing}
      dismissible={!busy}
      closeRequested={phase === "done"}
      onClose={onClose}
    >
      <div
        className={`${media.dialogBody} ${styles.editor}`}
        aria-busy={busy || decoding}
        data-cover-editor={step}
      >
        {step === "crop" && chosen ? (
          <>
            <ProfileCoverStage
              key={chosen.key}
              image={chosen.source.display}
              sourceWidth={chosen.source.pixels.width}
              headers={headers}
              thisDevice={thisDevice}
              identity={identity}
              locked={busy}
              autoFocus
              onAreaChange={(value) => {
                area.current = value;
                setAreaReady(true);
              }}
            >
              {/* Back (header) returns to the overview, as in the publishing crop. */}
              <div className={media.dialogActions}>
                <button
                  type="button"
                  className={media.secondaryButton}
                  disabled={busy || decoding}
                  onClick={pick}
                >
                  重新选择
                </button>
                <button
                  type="button"
                  className={media.primaryButton}
                  disabled={!allowed || busy || decoding || !areaReady}
                  onClick={() => void save()}
                >
                  {busy ? "保存中…" : failed ? "重试保存" : "保存"}
                </button>
              </div>
            </ProfileCoverStage>
            {/* Below the buttons: a status never pushes 保存 off a short screen. */}
            {opening}
            {progress}
            {problems}
          </>
        ) : (
          <>
            <DeviceTabs idBase={tabsId} value={device} onChange={setDevice} />
            <div
              className={styles.previewPanel}
              role="tabpanel"
              id={`${tabsId}-panel`}
              aria-labelledby={`${tabsId}-${device}`}
            >
              <ProfileCoverPreview
                src={
                  step === "remove" ? null : (profile.background?.src ?? null)
                }
                header={headers[device]}
                device={device}
                identity={identity}
              />
              <p className={styles.previewTitle}>
                {step === "remove"
                  ? "移除后主页将显示空白背景"
                  : profile.background
                    ? `当前背景在${DEVICE_LABELS[device]}上的效果`
                    : "尚未设置主页背景"}
              </p>
            </div>
            {step === "overview" && (
              <p className={media.dialogNote}>
                建议选择横向照片，重要内容放在画面中部偏上；不同机型显示范围略有差异。
              </p>
            )}
            {opening}
            {progress}
            {problems}
            <div className={media.dialogActions}>
              {step === "remove" ? (
                <>
                  <button
                    ref={keepRemove}
                    type="button"
                    className={media.secondaryButton}
                    disabled={busy}
                    onClick={toOverview}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className={media.primaryButton}
                    disabled={!allowed || busy}
                    onClick={() => void remove()}
                  >
                    {busy ? "移除中…" : failed ? "重试移除" : "确认移除"}
                  </button>
                </>
              ) : (
                <>
                  {profile.background && (
                    <button
                      type="button"
                      className={media.secondaryButton}
                      disabled={busy || decoding}
                      onClick={() => {
                        setError("");
                        setFailed(false);
                        setStep("remove");
                      }}
                    >
                      移除背景
                    </button>
                  )}
                  <button
                    ref={primary}
                    type="button"
                    className={media.primaryButton}
                    disabled={busy || decoding}
                    onClick={pick}
                  >
                    {profile.background ? "更换照片" : "选择照片"}
                  </button>
                </>
              )}
            </div>
          </>
        )}
        <input
          ref={input}
          hidden
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label="选择主页背景照片"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file && !saving.current) void select(file);
          }}
        />
      </div>
    </AuthorDialog>
  );
};
