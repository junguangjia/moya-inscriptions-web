import {
  COMMENT_IMAGE_LIMITS,
  validCommentImageOffsets,
} from "../../lib/public-api/comment-images-client";
import type { CommentImage, CommentImageInput } from "@moya/contracts";
import { authorClient } from "../authors/author-data";
import { requestIdentity } from "../shell/request-identity";
import {
  commentImageBoundary,
  commentImageInputs,
  commentImagePositionLabel,
  moveCommentImageToCaret,
  normalizeCommentImageDraft,
  rebaseCommentImageAnchors,
  reorderCommentImageAnchors,
} from "./comment-image-draft";
import type { CommentImageDraftAnchor } from "./comment-image-draft";
import {
  CommentImageError,
  createCommentUploadSession,
} from "./comment-image-upload-session";
import type {
  CommentImageUpload,
  CommentUploadSession,
} from "./comment-image-upload-session";

export interface CommentImageComposerOptions {
  readonly accountId: string | null;
  /** The host's existing per-content draft key, deliberately not its reply target. */
  readonly scopeKey: string;
  readonly text: string;
  readonly disabled?: boolean;
  /** A same-account identity refresh; suspend interaction without losing drafts. */
  readonly revalidating?: boolean;
}

/** Local identity-bound OS picker intent, never a transport credential. */
export interface CommentImagePick {
  readonly key: string;
}

export interface CommentImageComposerItem extends CommentImageDraftAnchor {
  readonly upload: CommentImageUpload;
  readonly positionLabel: string;
}

export interface CommentImageComposerSnapshot {
  readonly accountId: string | null;
  readonly scopeKey: string;
  readonly text: string;
  readonly items: readonly CommentImageComposerItem[];
  readonly notice: string;
  readonly adding: boolean;
  readonly pending: boolean;
  readonly picking: boolean;
  readonly pickerKey: string;
  readonly mutating: boolean;
  readonly revalidating: boolean;
  readonly connectionPaused: boolean;
  readonly reconnecting: boolean;
  readonly hasImages: boolean;
  readonly ready: boolean;
  /** Settled owner-authorized images only; unfinished files stay in the upload tray. */
  readonly previewImages: readonly CommentImage[];
  readonly previewText: string;
}

export interface CommentImageSubmission {
  readonly text: string;
  readonly images: readonly CommentImageInput[];
  readonly requestId: string;
  /** accepted=true is called only after the comment's durable receipt. */
  readonly finish: (accepted: boolean) => Promise<void>;
}

/**
 * Local editor coordination only. Text, mentions and reply targeting remain in
 * the existing host. No worker or upload session is created until a file pick.
 */
export class CommentImageComposerState {
  private options: CommentImageComposerOptions;
  private epoch: number;
  private active = true;
  private generation = 0;
  private selection = 0;
  private anchors: CommentImageDraftAnchor[] = [];
  private session: CommentUploadSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private adding = false;
  private reconnecting = false;
  private imageActions = new Set<string>();
  private pendingAnchor: { offset: number } | null = null;
  private filePick: {
    readonly intent: CommentImagePick;
    offset: number;
    files: readonly File[] | null;
  } | null = null;
  private ticket: object | null = null;
  private attempt: { intent: string; requestId: string } | null = null;
  private notice = "";
  private cached: CommentImageComposerSnapshot;

  constructor(options: CommentImageComposerOptions) {
    this.options = options;
    this.epoch = authorClient.accountEpoch();
    this.selection = options.text.length;
    this.cached = this.read();
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = () => this.cached;

  private sameAccount(): boolean {
    return (
      this.active &&
      this.options.accountId !== null &&
      authorClient.account() === this.options.accountId &&
      authorClient.accountEpoch() === this.epoch
    );
  }

  private read(): CommentImageComposerSnapshot {
    const snapshot = this.session?.snapshot();
    const uploads =
      snapshot?.items.filter((item) => item.phase !== "cancelled") ?? [];
    const byKey = new Map(uploads.map((item) => [item.key, item]));
    const anchors = [
      ...this.anchors.filter((anchor) => byKey.has(anchor.key)),
      ...uploads
        .filter(
          (item) => !this.anchors.some((anchor) => anchor.key === item.key),
        )
        .map((item) => ({
          key: item.key,
          offset: this.pendingAnchor?.offset ?? this.selection,
        })),
    ].sort((left, right) => left.offset - right.offset);
    const items = anchors.map((anchor) => ({
      ...anchor,
      upload: byKey.get(anchor.key)!,
      positionLabel: commentImagePositionLabel(
        this.options.text,
        anchor.offset,
      ),
    }));
    const normalized = normalizeCommentImageDraft(this.options.text, anchors);
    const offsets = new Map(
      normalized.images.map((anchor) => [anchor.key, anchor.offset]),
    );
    const previewImages = items.flatMap(({ upload }) => {
      const item = upload.serverItem;
      if (
        upload.phase !== "ready" ||
        upload.itemId === null ||
        item?.media == null ||
        item.presentation === null
      )
        return [];
      return [
        {
          id: upload.itemId,
          offset: offsets.get(upload.key) ?? 0,
          width: item.presentation.width,
          height: item.presentation.height,
          thumbSrc: item.media.thumbSrc,
          src: item.media.displaySrc,
          ...(item.media.fullSrc === undefined
            ? {}
            : { fullSrc: item.media.fullSrc }),
        },
      ];
    });
    const connectionPaused = snapshot?.status === "paused";
    return {
      accountId: this.options.accountId,
      scopeKey: this.options.scopeKey,
      text: this.options.text,
      items,
      notice: this.notice,
      adding: this.adding,
      pending: this.ticket !== null,
      picking: this.filePick !== null,
      pickerKey: this.pickerKey(),
      mutating: this.imageActions.size > 0 || this.filePick !== null,
      revalidating: !!this.options.revalidating,
      connectionPaused,
      reconnecting: this.reconnecting,
      hasImages:
        items.length > 0 ||
        this.adding ||
        (this.filePick?.files?.length ?? 0) > 0,
      ready:
        this.sameAccount() &&
        !this.options.disabled &&
        !this.options.revalidating &&
        !this.adding &&
        !this.reconnecting &&
        !connectionPaused &&
        this.ticket === null &&
        this.imageActions.size === 0 &&
        this.filePick === null &&
        items.every(
          ({ upload }) => upload.phase === "ready" && upload.itemId !== null,
        ),
      previewText: normalized.text,
      previewImages,
    };
  }

  private publish() {
    this.cached = this.read();
    for (const listener of [...this.listeners]) listener();
  }

  private detachSession(abandon: boolean) {
    const old = this.session;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session = null;
    if (abandon) void old?.abandon();
    return old;
  }

  private mutable(): boolean {
    return (
      this.sameAccount() &&
      !this.options.disabled &&
      !this.options.revalidating &&
      this.ticket === null
    );
  }

  private pickerKey(): string {
    return JSON.stringify([
      this.options.accountId,
      this.options.scopeKey,
      this.epoch,
    ]);
  }

  readonly activate = () => {
    this.active = true;
    this.publish();
  };

  readonly dispose = () => {
    this.active = false;
    this.generation++;
    this.detachSession(true);
    this.anchors = [];
    this.pendingAnchor = null;
    this.filePick = null;
    this.ticket = null;
    this.attempt = null;
    this.adding = false;
    this.reconnecting = false;
    this.imageActions.clear();
    this.publish();
  };

  readonly configure = (options: CommentImageComposerOptions) => {
    const epoch = authorClient.accountEpoch();
    if (
      this.options.accountId !== options.accountId ||
      this.options.scopeKey !== options.scopeKey ||
      this.epoch !== epoch
    ) {
      this.generation++;
      this.detachSession(true);
      this.anchors = [];
      this.pendingAnchor = null;
      this.filePick = null;
      this.ticket = null;
      this.attempt = null;
      this.notice = "";
      this.adding = false;
      this.reconnecting = false;
      this.imageActions.clear();
      this.selection = options.text.length;
      this.options = options;
      this.epoch = epoch;
      this.publish();
      return;
    }
    const changed =
      this.options.disabled !== options.disabled ||
      this.options.revalidating !== options.revalidating;
    this.textChanged(this.options.text, options.text);
    this.options = options;
    if (options.disabled) this.filePick = null;
    if (changed) this.publish();
    const picked = this.filePick;
    if (picked?.files && this.mutable()) {
      this.filePick = null;
      void this.addFilesAt(picked.files, picked.offset);
    }
  };

  /** Invoke before the host's setDraft, including mention-picker replacements. */
  readonly textChanged = (before: string, after: string) => {
    if (this.options.text === after) return;
    // The controller's text is authoritative when two host updates are batched.
    const previous = this.options.text === before ? before : this.options.text;
    this.anchors = rebaseCommentImageAnchors(previous, after, this.anchors);
    this.selection = rebaseCommentImageAnchors(previous, after, [
      { offset: this.selection },
    ])[0]!.offset;
    if (this.pendingAnchor !== null)
      this.pendingAnchor = rebaseCommentImageAnchors(previous, after, [
        this.pendingAnchor,
      ])[0]!;
    if (this.filePick !== null)
      this.filePick.offset = rebaseCommentImageAnchors(previous, after, [
        { offset: this.filePick.offset },
      ])[0]!.offset;
    this.options = { ...this.options, text: after };
    this.publish();
  };

  /** Mention insertion normalizes the old body and appends a handle in one action. */
  readonly normalizedTextChanged = (before: string, after: string) => {
    const previous = this.options.text === before ? before : this.options.text;
    const canonical = normalizeCommentImageDraft(previous, this.anchors);
    this.anchors = canonical.images;
    this.selection = normalizeCommentImageDraft(previous, [
      { offset: this.selection },
    ]).images[0]!.offset;
    if (this.pendingAnchor !== null)
      this.pendingAnchor = normalizeCommentImageDraft(previous, [
        this.pendingAnchor,
      ]).images[0]!;
    if (this.filePick !== null)
      this.filePick.offset = normalizeCommentImageDraft(previous, [
        { offset: this.filePick.offset },
      ]).images[0]!.offset;
    this.options = { ...this.options, text: canonical.text };
    if (canonical.text === after) this.publish();
    else this.textChanged(canonical.text, after);
  };

  readonly captureSelection = (
    box: Pick<HTMLTextAreaElement, "selectionEnd" | "value"> | null,
  ) => {
    if (box === null) return;
    this.selection = commentImageBoundary(this.options.text, box.selectionEnd);
  };

  readonly localStill = (key: string): Blob | null =>
    this.sameAccount() ? (this.session?.localStill(key) ?? null) : null;

  readonly beginFilePick = (): CommentImagePick | null => {
    if (
      !this.mutable() ||
      this.adding ||
      this.reconnecting ||
      this.imageActions.size > 0 ||
      this.filePick !== null
    )
      return null;
    const intent: CommentImagePick = { key: this.pickerKey() };
    this.filePick = {
      intent,
      offset: commentImageBoundary(this.options.text, this.selection),
      files: null,
    };
    this.publish();
    return intent;
  };

  readonly cancelFilePick = (intent?: CommentImagePick) => {
    if (intent !== undefined && this.filePick?.intent !== intent) return;
    this.filePick = null;
    this.publish();
  };

  readonly finishFilePick = async (
    files: readonly File[],
    intent: CommentImagePick,
  ) => {
    const picked = this.filePick;
    if (picked?.intent !== intent || intent.key !== this.pickerKey()) return;
    if (!this.sameAccount() || this.options.disabled || files.length === 0) {
      this.filePick = null;
      this.publish();
      return;
    }
    // Bound a deferred local selection before retaining it during /me refresh;
    // file decoding and all business writes still wait for confirmation.
    if (
      this.read().items.length + files.length >
        COMMENT_IMAGE_LIMITS.maxImages ||
      files.some(
        (file) => file.size === 0 || file.size > COMMENT_IMAGE_LIMITS.maxBytes,
      )
    ) {
      this.filePick = null;
      this.notice = `最多添加 ${COMMENT_IMAGE_LIMITS.maxImages} 张非空图片，每张不超过 10 MB。`;
      this.publish();
      return;
    }
    if (this.options.revalidating) {
      picked.files = [...files];
      this.publish();
      return;
    }
    this.filePick = null;
    await this.addFilesAt(files, picked.offset);
  };

  readonly addFiles = (files: readonly File[]) =>
    this.addFilesAt(files, this.selection);

  private async addFilesAt(files: readonly File[], offset: number) {
    if (
      !this.mutable() ||
      this.adding ||
      this.reconnecting ||
      this.imageActions.size > 0 ||
      this.filePick !== null ||
      files.length === 0
    )
      return;
    const run = this.generation;
    this.adding = true;
    this.notice = "";
    this.pendingAnchor = {
      offset: commentImageBoundary(this.options.text, offset),
    };
    let session = this.session;
    this.publish();
    try {
      if (session === null) {
        const created = createCommentUploadSession(this.options.accountId!);
        session = created;
        this.session = created;
        this.unsubscribe = created.subscribe(() => {
          if (this.active && this.session === created) this.publish();
        });
      }
      const keys = await session.add(files);
      if (!this.active || this.generation !== run || this.session !== session)
        return;
      this.anchors = [
        ...this.anchors,
        ...keys.map((key) => ({
          key,
          offset: this.pendingAnchor?.offset ?? this.selection,
        })),
      ].sort((left, right) => left.offset - right.offset);
    } catch (error) {
      if (this.active && this.generation === run && this.session === session)
        this.notice =
          error instanceof CommentImageError
            ? error.message
            : "图片暂时无法添加，请重试。";
    } finally {
      if (this.active && this.generation === run && this.session === session) {
        this.adding = false;
        this.pendingAnchor = null;
        this.publish();
      }
    }
  }

  private async imageAction(
    action: "remove" | "retry" | "useOriginal",
    key: string,
  ) {
    const session = this.session;
    if (
      !this.mutable() ||
      session === null ||
      this.adding ||
      this.imageActions.size > 0 ||
      this.filePick !== null
    )
      return;
    const run = this.generation;
    this.imageActions.add(key);
    this.notice = "";
    this.publish();
    try {
      await session[action](key);
      if (!this.active || this.generation !== run || this.session !== session)
        return;
      if (action === "remove") {
        this.anchors = this.anchors.filter((anchor) => anchor.key !== key);
        if (
          session.snapshot().items.every((item) => item.phase === "cancelled")
        )
          this.detachSession(true);
      }
    } catch (error) {
      if (this.active && this.generation === run && this.session === session)
        this.notice =
          error instanceof CommentImageError
            ? error.message
            : "图片操作未能确认，请重试。";
    } finally {
      if (this.active && this.generation === run) {
        this.imageActions.delete(key);
        this.publish();
      }
    }
  }

  readonly remove = (key: string) => this.imageAction("remove", key);
  readonly retry = (key: string) => this.imageAction("retry", key);
  readonly useOriginal = (key: string) => this.imageAction("useOriginal", key);

  readonly moveToCaret = (key: string) => {
    if (
      !this.mutable() ||
      this.adding ||
      this.imageActions.size > 0 ||
      this.filePick !== null
    )
      return;
    this.anchors = moveCommentImageToCaret(
      this.options.text,
      this.anchors,
      key,
      this.selection,
    );
    this.publish();
  };

  readonly reorder = (key: string, direction: -1 | 1) => {
    if (
      !this.mutable() ||
      this.adding ||
      this.imageActions.size > 0 ||
      this.filePick !== null
    )
      return;
    this.anchors = reorderCommentImageAnchors(this.anchors, key, direction);
    this.publish();
  };

  readonly retryConnection = async () => {
    const session = this.session;
    if (
      !this.mutable() ||
      session === null ||
      this.adding ||
      this.reconnecting ||
      this.imageActions.size > 0 ||
      this.filePick !== null
    )
      return;
    const run = this.generation;
    this.reconnecting = true;
    this.notice = "";
    this.publish();
    try {
      await session.resumeConnection();
    } catch (error) {
      if (this.active && this.generation === run && this.session === session)
        this.notice =
          error instanceof CommentImageError
            ? error.message
            : "图片连接暂时无法恢复，请重试。";
    } finally {
      if (this.active && this.generation === run && this.session === session) {
        this.reconnecting = false;
        this.publish();
      }
    }
  };

  /** identityKey contains the host's exact target/reply/mention intent. */
  readonly prepareSubmission = (
    identityKey: string,
  ): CommentImageSubmission | null => {
    if (
      this.adding ||
      this.ticket !== null ||
      this.imageActions.size > 0 ||
      this.filePick !== null
    )
      throw new CommentImageError("请等待图片添加或本次发送完成。");
    const rows = this.read().items;
    if (rows.length === 0) return null;
    if (!this.read().ready)
      throw new CommentImageError(
        "请等待图片上传和处理完成，或移除未完成的图片。",
      );
    const packet = commentImageInputs(
      this.options.text,
      rows.map(({ offset, upload }) => ({ offset, itemId: upload.itemId! })),
    );
    if (
      packet.text.length > 1000 ||
      !validCommentImageOffsets(packet.text, packet.images)
    )
      throw new CommentImageError("图片位置或正文长度已变化，请检查后再发送。");
    const intent = JSON.stringify([identityKey, packet.text, packet.images]);
    if (this.attempt?.intent !== intent)
      this.attempt = { intent, requestId: requestIdentity() };
    const requestId = this.attempt.requestId;
    const session = this.session;
    const run = this.generation;
    const ticket = {};
    this.ticket = ticket;
    this.publish();
    let finished = false;
    return {
      ...packet,
      requestId,
      finish: async (accepted) => {
        if (finished) return;
        finished = true;
        if (!this.active || this.generation !== run || this.ticket !== ticket)
          return;
        this.ticket = null;
        if (accepted) {
          this.attempt = null;
          this.anchors = [];
          this.notice = "";
          this.detachSession(false);
          // Cleanup is not submission: a lost retirement response must never
          // turn an already accepted comment into a visible send failure.
          void Promise.resolve()
            .then(() =>
              session?.committed(
                new Set(packet.images.map(({ itemId }) => itemId)),
              ),
            )
            .catch(() => undefined);
        }
        this.publish();
      },
    };
  };
}

export const createCommentImageComposerState = (
  options: CommentImageComposerOptions,
) => new CommentImageComposerState(options);

export { COMMENT_IMAGE_LIMITS, CommentImageError };
