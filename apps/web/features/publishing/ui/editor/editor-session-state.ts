import { remapMentions } from "../../../notifications/mention-edits";
import type { MentionReference } from "@moya/contracts";
import { itemDerivation } from "../../edit-readiness";
import { createExternalStore } from "../../upload-manager-store";
import {
  bodyRule,
  checkEditorText,
  issueMessage,
  originalAuthorRule,
  referenceTitleRule,
  sourceNoteRule,
  titleRule,
} from "./editor-text";

import type { EditorTextRule } from "./editor-text";
import type { EditReadinessState } from "../../edit-readiness";
import type { ExternalStore } from "../../upload-manager-store";
import type {
  UploadItemView,
  UploadManagerSnapshot,
} from "../../upload-manager";
import type { EditorSessionView } from "../../publishing-runtime";
import type { EditorTarget } from "../../../product-shell/product-history";
import type {
  MediaCrop,
  MediaEdit,
  PublishingMediaItem,
  WorkAuthorship,
  WorkAuthorshipKind,
  WorkDraftContent,
  WorkDraftItem,
  WorkPublishingFailureCode,
  WorkVisibility,
} from "@moya/contracts";

/**
 * One editing session's UI state (E04–E06, C01–C05, M02–M03, P03), hoisted
 * above every layout: the phone steps, the desktop editor and the preview
 * render the same store, so step changes and resizes never lose input. The
 * store lives in the account's editor registry (above the shell's overlay
 * host), so leaving the editor while uploads continue and returning through
 * the progress entry finds the same text, order and settings.
 *
 * Media and drafts UI reach a session by its `sessionKey` through
 * `useEditorSession(sessionKey)` (editor-session-provider.tsx) and change the
 * album only through its actions: `media()` / `setMedia()` / `updateMedia()`
 * for the ordered items, cover and cover crop (or the narrower `moveItem`,
 * `setCover`, `setItemEdit`, `removeItem`; removal changes content only, the
 * caller cancels the upload), `syncManagedItems()` to follow upload
 * identities without counting an author change, and `setOriginalNext()` for
 * the next batch's 原图画质.
 */

export type EditorStep = "media" | "text" | "confirm";

export type EditorPhase = "loading" | "ready" | "unavailable";

export type EditorField =
  | "title"
  | "body"
  | "referenceTitle"
  | "originalAuthor"
  | "sourceNote"
  | "media"
  | "general";

export type ReferenceField = "referenceTitle" | "originalAuthor" | "sourceNote";

export type ReferenceFields = Readonly<Record<ReferenceField, string>>;

export interface EditorSessionState {
  /** Stable for the life of the session, also across target replacement. */
  readonly key: string;
  readonly accountId: string;
  /** The editor entry this session answers to; follows a newly created draft. */
  readonly target: EditorTarget;
  /** What the session was opened as (the progress entry reopens with it). */
  readonly openedAs: EditorTarget;
  readonly phase: EditorPhase;
  readonly unavailableMessage: string | null;
  /** Whether this edits an existing work (title 编辑作品, primary 保存更新). */
  readonly kind: "new" | "edit";
  readonly workId: string | null;
  readonly title: string;
  readonly body: string;
  readonly mentions: readonly MentionReference[];
  /** `null` = 未设置: nothing is preselected and a choice can be cleared (C05). */
  readonly authorshipKind: WorkAuthorshipKind | null;
  /** Kept while switching kinds, so 原创 → 临摹 → back restores what was typed. */
  readonly reference: ReferenceFields;
  readonly visibility: WorkVisibility;
  readonly items: readonly WorkDraftItem[];
  readonly coverKey: string | null;
  readonly coverCrop: MediaCrop | null;
  /** Owner views of items known from the draft or the editable work, by item id. */
  readonly serverItems: Readonly<Record<string, PublishingMediaItem>>;
  readonly step: EditorStep;
  /** 原图画质 for the next selection batch (reset after each batch). */
  readonly originalNext: boolean;
  /** Increases with every author change (not with loads or upload identities). */
  readonly editVersion: number;
  readonly fieldErrors: Readonly<Partial<Record<EditorField, string>>>;
  readonly notice: string | null;
  /**
   * An edit draft this session created on open, as it was then; removed
   * again on leaving only while the account still holds it unchanged.
   */
  readonly openedEditDraft: OpenedEditDraft | null;
  /** The runtime session is being replaced (drafts turned on for an edit). */
  readonly restarting: boolean;
}

export interface OpenedEditDraft {
  readonly id: string;
  readonly workId: string;
  /** The revision the deletion is conditional on. */
  readonly revision: number;
}

const emptyReference: ReferenceFields = {
  referenceTitle: "",
  originalAuthor: "",
  sourceNote: "",
};

export const createEditorState = (
  key: string,
  accountId: string,
  target: EditorTarget,
): EditorSessionState => ({
  key,
  accountId,
  target,
  openedAs: target,
  phase: target.type === "new" ? "ready" : "loading",
  unavailableMessage: null,
  kind: target.type === "work" ? "edit" : "new",
  workId: target.type === "work" ? target.id : null,
  title: "",
  body: "",
  mentions: [],
  // Nothing is claimed on the author's behalf: 未设置 until they choose (C05).
  authorshipKind: null,
  reference: emptyReference,
  // New works default to public (P03); edits inherit when loaded.
  visibility: "public",
  items: [],
  coverKey: null,
  coverCrop: null,
  serverItems: {},
  step: "media",
  originalNext: false,
  editVersion: 0,
  fieldErrors: {},
  notice: null,
  openedEditDraft: null,
  restarting: false,
});

// ---------------------------------------------------------------------------
// Content

/**
 * The authorship the state describes (references only when typed), or `null`
 * while none is set: no kind is ever inferred for the author (C05).
 */
export const authorshipOf = (
  state: Pick<EditorSessionState, "authorshipKind" | "reference">,
): WorkAuthorship | null => {
  if (state.authorshipKind === null) return null;
  if (state.authorshipKind === "original") return { kind: "original" };
  const fields: { -readonly [K in ReferenceField]?: string } = {};
  for (const field of [
    "referenceTitle",
    "originalAuthor",
    "sourceNote",
  ] as const)
    if (state.reference[field].trim() !== "")
      fields[field] = state.reference[field];
  return { kind: state.authorshipKind, ...fields };
};

/** The draft content this state describes (also the submitted content). */
export const contentOf = (state: EditorSessionState): WorkDraftContent => ({
  title: state.title,
  body: state.body,
  ...(state.mentions.length ? { mentions: [...state.mentions] } : {}),
  authorship: authorshipOf(state),
  visibility: state.visibility,
  items: [...state.items],
  coverKey: state.coverKey,
  coverCrop: state.coverKey === null ? null : state.coverCrop,
});

type ManagedItem = Pick<
  WorkDraftItem,
  "key" | "itemId" | "kind" | "qualityMode" | "pendingLabel" | "origin"
>;

/**
 * The same rule the runtime applies before saving: identities and quality of
 * items the manager knows follow the manager; items it adds are appended as
 * pending entries in the order they were confirmed. The clipboard provenance
 * of a key is kept once either side names it (a restored draft carries it in
 * its content).
 */
export const mergeManagedItems = (
  items: readonly WorkDraftItem[],
  managed: readonly ManagedItem[],
): readonly WorkDraftItem[] => {
  const byKey = new Map(managed.map((item) => [item.key, item]));
  let changed = false;
  const merged = items.map((item): WorkDraftItem => {
    const current = byKey.get(item.key);
    if (!current) return item;
    const origin = item.origin ?? current.origin;
    if (
      current.itemId === item.itemId &&
      current.qualityMode === item.qualityMode &&
      origin === item.origin
    )
      return item;
    changed = true;
    const base = {
      key: item.key,
      kind: item.kind,
      qualityMode: current.qualityMode,
      edit: item.edit,
      ...(origin === undefined ? {} : { origin }),
    };
    return current.itemId === null
      ? {
          ...base,
          itemId: null,
          pendingLabel: item.kind === "live" ? "live" : "photo",
        }
      : { ...base, itemId: current.itemId };
  });
  const known = new Set(items.map((item) => item.key));
  const appended = managed
    .filter((item) => !known.has(item.key))
    .map((item): WorkDraftItem => ({
      ...item,
      edit: { rotation: 0, crop: null },
    }));
  return !changed && appended.length === 0 ? items : [...merged, ...appended];
};

/**
 * Whether two contents carry the same author input: text, settings, order,
 * edits and cover. Upload identities (item id, quality, pending label) are
 * not author input and may differ between an editor and a saved copy.
 */
export const sameAuthorContent = (
  left: WorkDraftContent,
  right: WorkDraftContent,
): boolean => {
  const crop = (value: MediaCrop | null) =>
    value === null ? null : [value.x, value.y, value.width, value.height];
  const project = (content: WorkDraftContent) =>
    JSON.stringify([
      content.title,
      content.body,
      content.mentions ?? [],
      content.authorship === null
        ? null
        : [
            content.authorship.kind,
            content.authorship.kind === "original"
              ? null
              : [
                  content.authorship.referenceTitle ?? "",
                  content.authorship.originalAuthor ?? "",
                  content.authorship.sourceNote ?? "",
                ],
          ],
      content.visibility,
      content.items.map((item) => [
        item.key,
        item.kind,
        item.edit.rotation,
        crop(item.edit.crop),
      ]),
      content.coverKey,
      content.coverKey === null ? null : crop(content.coverCrop),
    ]);
  return project(left) === project(right);
};

/** Apply only author changes made after a conflict to the chosen version. */
export const preserveLaterConflictEdits = (
  selected: WorkDraftContent,
  device: WorkDraftContent,
  screen: WorkDraftContent,
): WorkDraftContent => {
  const changed = (patch: Partial<WorkDraftContent>) =>
    !sameAuthorContent(device, { ...device, ...patch });
  // Album, cover and cover crop move together: a cover must name a retained item.
  const album = {
    items: screen.items,
    coverKey: screen.coverKey,
    coverCrop: screen.coverCrop,
  };
  return {
    ...selected,
    ...(changed({ title: screen.title }) ? { title: screen.title } : {}),
    ...(changed({ body: screen.body, mentions: screen.mentions ?? [] })
      ? { body: screen.body, mentions: screen.mentions ?? [] }
      : {}),
    ...(changed({ authorship: screen.authorship })
      ? { authorship: screen.authorship }
      : {}),
    ...(changed({ visibility: screen.visibility })
      ? { visibility: screen.visibility }
      : {}),
    ...(changed(album) ? album : {}),
  };
};

const referenceOf = (authorship: WorkAuthorship): ReferenceFields =>
  authorship.kind === "original"
    ? emptyReference
    : {
        referenceTitle: authorship.referenceTitle ?? "",
        originalAuthor: authorship.originalAuthor ?? "",
        sourceNote: authorship.sourceNote ?? "",
      };

// ---------------------------------------------------------------------------
// Validation and readiness

export interface FieldCheck {
  readonly field: EditorField;
  readonly label: string;
  readonly length: number;
  readonly maximum: number;
  readonly message: string | null;
}

const check = (
  field: EditorField,
  label: string,
  raw: string,
  rule: EditorTextRule,
): FieldCheck => {
  const result = checkEditorText(raw, rule);
  return {
    field,
    label,
    length: result.length,
    maximum: rule.maximum,
    message:
      result.issue === null
        ? null
        : issueMessage(label, result.issue, rule.maximum),
  };
};

export const titleCheck = (state: EditorSessionState) =>
  check("title", "标题", state.title, titleRule);
export const bodyCheck = (state: EditorSessionState) =>
  check("body", "正文", state.body, bodyRule);

export const referenceChecks = (state: EditorSessionState): FieldCheck[] =>
  state.authorshipKind === null || state.authorshipKind === "original"
    ? []
    : [
        check(
          "referenceTitle",
          "参考作品",
          state.reference.referenceTitle,
          referenceTitleRule,
        ),
        check(
          "originalAuthor",
          "原作者",
          state.reference.originalAuthor,
          originalAuthorRule,
        ),
        check("sourceNote", "来源", state.reference.sourceNote, sourceNoteRule),
      ];

/** Every local text problem, in reading order (title, body, authorship). */
export const localIssues = (state: EditorSessionState): FieldCheck[] =>
  [titleCheck(state), bodyCheck(state), ...referenceChecks(state)].filter(
    (entry) => entry.message !== null,
  );

export const isEmptyWork = (state: EditorSessionState): boolean =>
  checkEditorText(state.title, titleRule).length === 0 &&
  checkEditorText(state.body, bodyRule).length === 0 &&
  state.items.length === 0;

export interface Readiness {
  /** Retained items. */
  readonly total: number;
  readonly ready: number;
  /** Retained items that keep submission from being confirmed. */
  readonly blocking: number;
  /** Exact wording, e.g. "2 项仍在上传，1 项失败"; null when nothing blocks. */
  readonly text: string | null;
  /**
   * Nothing blocks and the account's last readiness answer does not say
   * otherwise: only then may the editor claim 全部已就绪 (QA D1).
   */
  readonly confirmed: boolean;
  /** Account items whose state this editor has not read yet. */
  readonly unknownItemIds: readonly string[];
}

const phaseGroups: readonly (readonly [
  readonly UploadItemView["phase"][],
  string,
])[] = [
  [["waiting", "preprocessing", "registering"], "正在准备"],
  [["needs_choice"], "需要选择"],
  [["queued", "uploading"], "仍在上传"],
  [["uploaded", "processing"], "正在处理"],
  [[], "正在确认状态"],
  [["paused"], "已暂停"],
  [["failed"], "失败"],
  [["missing_local"], "缺少本地文件"],
];

/**
 * Readiness of the retained album: items the manager tracks use its phases;
 * items only known from the account (an edit's existing media) use their
 * server state, and one whose state is not known yet is never counted as
 * ready. Cancelled items are not retained. An item the account has made
 * ready still counts as processing while its rotation, crop or cover crop
 * has no confirmed derivatives (`edits`, QA D1), and as failed when their
 * derivation failed.
 */
export const readinessOf = (
  state: EditorSessionState,
  uploads: UploadManagerSnapshot | null,
  edits: EditReadinessState | null = null,
): Readiness => {
  const views = new Map(
    (uploads?.items ?? []).map((item) => [item.key, item] as const),
  );
  const counts = new Map<string, number>();
  const count = (label: string, by = 1) =>
    counts.set(label, (counts.get(label) ?? 0) + by);
  let ready = 0;
  let total = 0;
  let other = 0;
  const unknownItemIds: string[] = [];
  const album = { coverKey: state.coverKey, coverCrop: state.coverCrop };
  /** A ready item is ready only with its edit derivatives. */
  const countReady = (item: WorkDraftItem) => {
    switch (itemDerivation(item, album, edits)) {
      case "pending":
        count("正在处理");
        return;
      case "failed":
        count("失败");
        return;
      default:
        ready += 1;
    }
  };
  for (const item of state.items) {
    const view = views.get(item.key);
    if (view?.phase === "cancelled" || view?.phase === "cleanup") continue;
    total += 1;
    if (view) {
      if (view.phase === "ready") {
        countReady(item);
        continue;
      }
      const group = phaseGroups.find(([phases]) => phases.includes(view.phase));
      if (group) count(group[1]);
      continue;
    }
    const server =
      item.itemId === null ? undefined : state.serverItems[item.itemId];
    if (item.itemId !== null && server === undefined) {
      unknownItemIds.push(item.itemId);
      count("正在确认状态");
    } else if (server?.state === "ready") countReady(item);
    else if (server?.state === "failed") count("失败");
    else if (server?.state === "processing") count("正在处理");
    else other += 1;
  }
  if (other > 0) count("缺少本地文件", other);
  const parts = phaseGroups
    .map(([, label]) => label)
    .filter((label) => (counts.get(label) ?? 0) > 0)
    .map((label) => `${counts.get(label)} 项${label}`);
  const blocking = total - ready;
  return {
    total,
    ready,
    blocking,
    text: parts.length === 0 ? null : parts.join("，"),
    // The account's last word stands: not ready is never shown as ready.
    confirmed: blocking === 0 && edits?.status !== "not_ready",
    unknownItemIds,
  };
};

/** Where a Backend failure code belongs (E08: failures at their field). */
export const failureField = (
  code: WorkPublishingFailureCode | string | null,
): EditorField => {
  switch (code) {
    case "title_too_long":
    case "title_line_break":
      return "title";
    case "body_too_long":
      return "body";
    case "reference_title_too_long":
      return "referenceTitle";
    case "original_author_too_long":
      return "originalAuthor";
    case "source_note_too_long":
      return "sourceNote";
    case "items_limit":
    case "not_ready":
    case "unsupported_type":
    case "pairing_mismatch":
    case "original_item_too_large":
    case "component_too_large":
      return "media";
    default:
      return "general";
  }
};

/** Whether a phone step shows the field. */
export const fieldStep = (field: EditorField): EditorStep =>
  field === "media" ? "media" : field === "general" ? "confirm" : "text";

// ---------------------------------------------------------------------------
// Store

export interface EditorMediaValue {
  readonly items: readonly WorkDraftItem[];
  readonly coverKey: string | null;
  readonly coverCrop: MediaCrop | null;
}

export interface EditorSessionStore {
  readonly key: string;
  readonly accountId: string;
  readonly store: ExternalStore<EditorSessionState>;
  get(): EditorSessionState;
  subscribe(listener: () => void): () => void;
  content(): WorkDraftContent;

  // Author changes (each is an edit).
  setTitle(value: string): void;
  setBody(value: string, mentions?: readonly MentionReference[]): void;
  /** `null` clears the choice back to 未设置. */
  setAuthorshipKind(kind: WorkAuthorshipKind | null): void;
  setReference(field: ReferenceField, value: string): void;
  setVisibility(visibility: WorkVisibility): void;
  moveItem(key: string, toIndex: number): void;
  setItemOrder(keys: readonly string[]): void;
  setCover(key: string | null): void;
  setCoverCrop(crop: MediaCrop | null): void;
  setItemEdit(key: string, edit: MediaEdit): void;
  /** Removes an item from the album (the caller cancels its upload). */
  removeItem(key: string): void;
  /** The album part of the content: ordered items, cover and cover crop. */
  media(): EditorMediaValue;
  /** Replaces the album part (an edit when it changes). */
  setMedia(next: EditorMediaValue): void;
  updateMedia(change: (current: EditorMediaValue) => EditorMediaValue): void;

  // Session changes (never an edit).
  setStep(step: EditorStep): void;
  setOriginalNext(original: boolean): void;
  syncManagedItems(managed: readonly ManagedItem[]): void;
  /** Replaces the content with a loaded, restored or chosen version. */
  adoptContent(
    content: WorkDraftContent,
    serverItems?: readonly PublishingMediaItem[],
  ): void;
  mergeServerItems(items: readonly PublishingMediaItem[]): void;
  setLoaded(options: {
    readonly kind: "new" | "edit";
    readonly workId: string | null;
    readonly openedEditDraft?: OpenedEditDraft | null;
  }): void;
  /** The opened edit draft is no longer this session's to remove. */
  keepOpenedEditDraft(): void;
  setRestarting(restarting: boolean): void;
  setUnavailable(message: string): void;
  setLoading(): void;
  setTarget(target: EditorTarget): void;
  setFieldErrors(errors: Partial<Record<EditorField, string>>): void;
  setNotice(notice: string | null): void;
}

let sessionSequence = 0;

const withoutField = (
  errors: EditorSessionState["fieldErrors"],
  field: EditorField,
) => {
  if (errors[field] === undefined) return errors;
  const next = { ...errors };
  delete next[field];
  return next;
};

export const createEditorSessionStore = (
  accountId: string,
  target: EditorTarget,
): EditorSessionStore => {
  sessionSequence += 1;
  const key = `editor-session-${sessionSequence}`;
  // Synchronous notification: controlled inputs must re-render in their event.
  const store = createExternalStore(
    createEditorState(key, accountId, target),
    (flush) => flush(),
  );
  const update = (change: (state: EditorSessionState) => EditorSessionState) =>
    store.set(change(store.get()));
  const edit = (
    field: EditorField | null,
    change: (state: EditorSessionState) => Partial<EditorSessionState>,
  ) =>
    update((state) => {
      const patch = change(state);
      return {
        ...state,
        ...patch,
        editVersion: state.editVersion + 1,
        fieldErrors:
          field === null
            ? state.fieldErrors
            : withoutField(state.fieldErrors, field),
      };
    });
  const setMedia = (next: EditorMediaValue) => {
    const state = store.get();
    if (
      next.items === state.items &&
      next.coverKey === state.coverKey &&
      next.coverCrop === state.coverCrop
    )
      return;
    edit("media", () => ({
      items: next.items,
      coverKey:
        next.coverKey !== null &&
        next.items.some((item) => item.key === next.coverKey)
          ? next.coverKey
          : null,
      coverCrop: next.coverKey === null ? null : next.coverCrop,
    }));
  };
  const reorder = (state: EditorSessionState, keys: readonly string[]) => {
    const byKey = new Map(state.items.map((item) => [item.key, item]));
    const ordered = keys.flatMap((itemKey) => {
      const item = byKey.get(itemKey);
      byKey.delete(itemKey);
      return item ? [item] : [];
    });
    return [...ordered, ...byKey.values()];
  };

  return {
    key,
    accountId,
    store,
    get: () => store.get(),
    subscribe: (listener) => store.subscribe(listener),
    content: () => contentOf(store.get()),

    setTitle: (value) => edit("title", () => ({ title: value })),
    setBody: (value, mentions) =>
      edit("body", (state) => ({
        body: value,
        mentions: mentions ?? remapMentions(state.body, value, state.mentions),
      })),
    setAuthorshipKind: (kind) =>
      edit(null, (state) => ({
        authorshipKind: kind,
        fieldErrors:
          kind === null || kind === "original"
            ? withoutField(
                withoutField(
                  withoutField(state.fieldErrors, "referenceTitle"),
                  "originalAuthor",
                ),
                "sourceNote",
              )
            : state.fieldErrors,
      })),
    setReference: (field, value) =>
      edit(field, (state) => ({
        reference: { ...state.reference, [field]: value },
      })),
    setVisibility: (visibility) => edit(null, () => ({ visibility })),
    moveItem: (itemKey, toIndex) =>
      edit("media", (state) => {
        const from = state.items.findIndex((item) => item.key === itemKey);
        if (from < 0) return {};
        const items = [...state.items];
        const [moved] = items.splice(from, 1);
        const bounded = Math.max(0, Math.min(items.length, toIndex));
        items.splice(bounded, 0, moved!);
        return { items };
      }),
    setItemOrder: (keys) =>
      edit("media", (state) => ({ items: reorder(state, keys) })),
    setCover: (coverKey) =>
      edit(null, (state) => ({
        coverKey:
          coverKey !== null && state.items.some((item) => item.key === coverKey)
            ? coverKey
            : null,
        coverCrop: coverKey === state.coverKey ? state.coverCrop : null,
      })),
    setCoverCrop: (coverCrop) =>
      edit(null, (state) => ({
        coverCrop: state.coverKey === null ? null : coverCrop,
      })),
    setItemEdit: (itemKey, itemEdit) =>
      edit(null, (state) => ({
        items: state.items.map((item) =>
          item.key === itemKey ? { ...item, edit: itemEdit } : item,
        ),
      })),
    removeItem: (itemKey) =>
      edit("media", (state) => {
        if (!state.items.some((item) => item.key === itemKey)) return {};
        const items = state.items.filter((item) => item.key !== itemKey);
        const coverRemoved = state.coverKey === itemKey;
        return {
          items,
          ...(coverRemoved
            ? {
                coverKey: null,
                coverCrop: null,
                // M03: deterministic fallback, told to the author.
                notice:
                  items.length > 0
                    ? "封面已移除，将以第一项作为封面"
                    : "封面已移除",
              }
            : {}),
        };
      }),
    media: () => {
      const { items, coverKey, coverCrop } = store.get();
      return { items, coverKey, coverCrop };
    },
    setMedia: (next) => setMedia(next),
    updateMedia: (change) => {
      const { items, coverKey, coverCrop } = store.get();
      setMedia(change({ items, coverKey, coverCrop }));
    },

    setStep: (step) =>
      update((state) => (state.step === step ? state : { ...state, step })),
    setOriginalNext: (originalNext) =>
      update((state) =>
        state.originalNext === originalNext
          ? state
          : { ...state, originalNext },
      ),
    syncManagedItems: (managed) =>
      update((state) => {
        const items = mergeManagedItems(state.items, managed);
        return items === state.items ? state : { ...state, items };
      }),
    adoptContent: (content, serverItems = []) =>
      update((state) => ({
        ...state,
        title: content.title,
        body: content.body,
        mentions: content.mentions ?? [],
        authorshipKind: content.authorship?.kind ?? null,
        reference:
          content.authorship === null || content.authorship.kind === "original"
            ? state.reference
            : referenceOf(content.authorship),
        visibility: content.visibility,
        items: content.items,
        coverKey: content.coverKey,
        coverCrop: content.coverCrop,
        serverItems: {
          ...state.serverItems,
          ...Object.fromEntries(serverItems.map((item) => [item.id, item])),
        },
        fieldErrors: {},
      })),
    mergeServerItems: (items) =>
      update((state) =>
        items.length === 0
          ? state
          : {
              ...state,
              serverItems: {
                ...state.serverItems,
                ...Object.fromEntries(items.map((item) => [item.id, item])),
              },
            },
      ),
    setLoaded: ({ kind, workId, openedEditDraft = null }) =>
      update((state) => ({
        ...state,
        phase: "ready",
        unavailableMessage: null,
        kind,
        workId,
        openedEditDraft,
      })),
    keepOpenedEditDraft: () =>
      update((state) =>
        state.openedEditDraft === null
          ? state
          : { ...state, openedEditDraft: null },
      ),
    setRestarting: (restarting) =>
      update((state) =>
        state.restarting === restarting ? state : { ...state, restarting },
      ),
    setUnavailable: (message) =>
      update((state) => ({
        ...state,
        phase: "unavailable",
        unavailableMessage: message,
      })),
    setLoading: () =>
      update((state) => ({
        ...state,
        phase: "loading",
        unavailableMessage: null,
      })),
    setTarget: (next) => update((state) => ({ ...state, target: next })),
    setFieldErrors: (fieldErrors) =>
      update((state) => ({ ...state, fieldErrors })),
    setNotice: (notice) =>
      update((state) =>
        state.notice === notice ? state : { ...state, notice },
      ),
  };
};

// ---------------------------------------------------------------------------
// Registry

/**
 * Whether an open editor entry answers to this session: the same draft or
 * work, a new work (one new-work session at a time), or the draft this
 * session created.
 */
export const sessionAnswers = (
  state: EditorSessionState,
  target: EditorTarget,
  runtimeSession: EditorSessionView | null,
): boolean => {
  const draftId =
    runtimeSession?.draftId ??
    (state.target.type === "draft" ? state.target.id : null);
  switch (target.type) {
    case "new":
      return state.openedAs.type === "new";
    case "draft":
      return (
        draftId === target.id ||
        (state.openedAs.type === "draft" && state.openedAs.id === target.id)
      );
    case "work":
      return state.workId === target.id;
  }
};

export type SessionResolution =
  | { readonly kind: "store"; readonly store: EditorSessionStore }
  /** Another session of this account is still open (only one at a time). */
  | {
      readonly kind: "other";
      readonly store: EditorSessionStore | null;
      readonly session: EditorSessionView | null;
    }
  | { readonly kind: "create" };

export const resolveSession = (
  store: EditorSessionStore | null,
  target: EditorTarget,
  runtimeSession: EditorSessionView | null,
): SessionResolution => {
  if (store !== null)
    return sessionAnswers(store.get(), target, runtimeSession)
      ? { kind: "store", store }
      : { kind: "other", store, session: runtimeSession };
  return runtimeSession === null
    ? { kind: "create" }
    : { kind: "other", store: null, session: runtimeSession };
};
