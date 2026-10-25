# Media composer tall-work framing V1

Issue [#341](https://github.com/junguangjia/moya-inscriptions-web/issues/341).
Status: implementation candidate in one PR. Owner device acceptance, Ready,
merge and the Production release are separate steps.

Tall works (rubbings, scrolls, standing steles) lost most of their height in the
phone single-column feed. That stage is 1:1 to 4:5 and centre-crops anything
taller, and the phone crop offered only fixed ratios. This task adds two things
on top of the phone posting flow ([Media composer V1](./media-composer-v1.md)):

- an iOS Photos style **freeform crop** on 编辑;
- a per-photo **feed framing**: which part of a tall photo the feed shows
  (局部), or the whole photo with blank sides (整张). Without a choice an
  uncropped photo is shown whole and a cropped one centred (decision 8).

## Owner decisions (2026-10-25, frozen)

1. **Freeform crop, phone 编辑 only.**
   - Four corner handles with targets of at least 44 px. The opposite corner
     stays anchored during a drag.
   - On release the window re-centres and zooms to fill the crop field.
   - The ratio row is 原始比例 · 自由 · 4:5 · 3:4 · 1:1 · 4:3. A preset locks
     its ratio during a corner drag; 自由 is free.
   - 原始比例 always means crop null. A corner drag, or a pinch or move that
     makes a real crop, switches it to 自由.
   - A stored crop outside the phone's presets (16:9, 9:16, a zoomed crop of the
     frame's own shape) reopens as 自由 on the phone only. The desktop dialog
     keeps its labels.
   - 应用到全部 stays preset-only and never touches framing.
   - Rotation stays in 90° steps; a turn at 自由 starts again at 原始比例.
2. **Feed framing lives inside `MediaEdit`** as the optional `edit.feed`. There
   is no migration and no new derivative. A framing-only change never marks a
   work 已编辑. Absent means the item's default framing (decision 8; before r3,
   always a centred cover).
3. **The 「动态流」 tool on phone 编辑** replaces the 动态流参考线 toggle.
   - It is off by default. While it is on, the crop pauses and the corner
     handles hide.
   - For a photo taller than the feed stage, the author chooses 局部 (drag the
     window vertically, or use the keyboard slider) or 整张 (the whole photo,
     blank side margins).
   - For any other photo it says the feed shows it whole, with no choice.
   - Framing is per photo and kept at once. 还原 resets crop, rotation and
     framing, with 撤销.
4. **Owner changes to the plan's defaults.**
   - (a) The desktop media edit dialog (896 px and wider) also offers the choice
     of 局部 or 整张 in its feed window, plus the vertical region drag and keys.
     The choice is kept by the dialog's 完成 and reset by its 还原, under its
     dirty guard. Desktop gets no corner-handle crop.
   - (b) Two-column, tablet and PC work cards follow the cover photo's framing
     when the revision has no cover composition. 局部 positions the image at y
     in the card box; 整张 shows it whole with side margins. With a cover
     composition the card is unchanged.
5. **Corner handles and the stage buttons (照片留边).**
   - While handles are offered, the crop field is the stage less 60 px at the
     top and bottom and 16 px at the sides (`CROP_FIELD_INSETS`). The top row
     ends 52 px down (8 px plus a 44 px button), and 还原 · 旋转 sit side by
     side at the bottom right, so no button covers a handle.
   - A field smaller than 132 px either way keeps the whole stage, without
     handles.
   - 封面构图 keeps inset 0 and its layout.
6. **Carried-over (Phase 4, non-editable) photos can take 局部 · 整张.** The
   band and slider are drawn over their still, and the server emits `feed` for
   them too.
7. One PR, no dependency changes, no Production step in this task.
8. **The default framing follows the crop** (r3, 2026-10-25, after the Owner's
   device check passed).
   - An uncropped photo (原始比例, crop null) is shown whole (`contain`) by
     default: a taller one with blank sides, a wider one whole with blank above
     and below, as before. This also applies to works already published, with no
     data change.
   - A cropped photo (自由 or a preset) keeps a centred cover (局部居中) by
     default. Switching back to 原始比例, or 还原, brings back the whole-image
     default.
   - An explicit author choice in 「动态流」 always wins.

## Contract

`packages/contracts` (the only place shared types live):

```ts
mediaFeedFramingSchema = { fit: "contain" } | { fit: "cover", y: 0..1 }  // strict objects
mediaEditSchema        = { rotation, crop, feed?: MediaFeedFraming }
MEDIA_FEED_CENTRE      = 0.5
```

- **Meaning.** `feed` applies only while the edited frame (after rotation and
  crop) is taller than the box that shows it.
  - `cover` shows the region at `y`, its vertical position inside the overflow
    (0 top, 0.5 centre, 1 bottom; CSS `object-position`).
  - `contain` shows the whole frame with blank sides.
  - On a frame that is not taller than its box, a stored framing is dormant. It
    is kept, and comes back if the frame becomes tall again (for example after a
    reorder changes photo 1). A card never brings it back (see Rendering).
- **Default.** `defaultFeed(edit)` is `{fit:"contain"}` when `edit.crop` is
  null, otherwise the centred cover. The effective framing is
  `edit.feed ?? defaultFeed(edit)` (`effectiveFeed`).
- **Stored form** (drafts, revisions, editable content). `edit.feed` is only an
  explicit choice that differs from the item's default. Clients round `y` to
  1e-4 and omit the default; `normalizeFeed` and `withFeed` do both against the
  edit's crop.
  - An uncropped photo stores 局部 even at the centre (`{fit:"cover", y:0.5}`)
    and never stores `{fit:"contain"}`.
  - A cropped photo stores `{fit:"contain"}` and never the centred cover.
  - `sameFeed(a, b, edit)` compares effective framings for that edit's crop.
  - A pixel change is stored against the new crop (`setItemEdit`): a choice that
    is the new crop's default is no longer stored, and a photo without a choice
    takes the new crop's default. For example, an explicit centred 局部 on an
    uncropped photo goes once the photo is cropped, so 原始比例 then shows it
    whole. The 撤销 of a turn or of 应用到全部 gives such a choice back
    (`undoneFeed`).
  - One exception: a desktop dialog's choice that a layout swap hands over with
    an unkept crop waits spelled out until the stage keeps that crop
    (`setItemFeedAhead`, under Desktop dialog). Every reader treats a
    spelled-out default as the default.
- **Reader form** (every public read). The effective framing, where absent means
  a centred cover, as all reader code already assumes. `readerFeed` on the Web
  gives the same value for previews.
- **Identity stays pixel-only.** These read rotation and crop only:
  - `community.media_edit_key` and `community.work_content_sha256`;
  - `normalizedEdit` and every derive job payload;
  - the processor and sandbox edit parsers;
  - the Web `derivationSignature`, the preview's edit key, `sameEdit` and
    `closeEdit`.

  A framing change therefore never re-derives, never asks readiness again, never
  resets a cover composition and never sets a crop draft aside.

- **Public reads** carry the reader form (`publicFeed` in `media-read.ts`):
  - A valid stored choice is emitted unless it is the centred cover, so an
    explicit `{fit:"cover", y:0.5}` reads absent, on an uncropped item too. A
    stored cover position is rounded to 1e-4 first, as the editor stores it,
    and the rounded `y` is emitted: `0.50004` reads absent, `0.12345` reads
    `0.1235`.
  - Without a valid stored choice (none, or an invalid value, which is dropped),
    the item's default applies. An uncropped item gets `{fit:"contain"}` only
    when its shown frame is taller than a square (h/w > 1 + 0.001). On a square
    or wider frame `contain` changes nothing, so those payloads keep their exact
    shape. A cropped item reads absent.
  - The shown frame is the one the read already sizes: the legacy PNG for an
    unedited carried-over item, the display derivative (or the presentation
    fallback) for `Work.media` and the gallery, and the card cover derivative
    for the card's `media` and `Work.coverFeed`. The SQL tests the crop as
    `COALESCE(jsonb_typeof(edit->'crop'),'null') = 'null'`, since it is stored
    as JSON null.
  - Carried-over (Phase 4) items have crop null, so they take the whole default
    too.
  - Under a cover composition, neither a choice nor the default reaches the card
    `media` or `Work.coverFeed`.

  The fields:

  - `ContentCard.gallery[].feed` (work cards only; a refine rejects it on other
    targets);
  - `ContentCard.media.feed`, the cover, only when the revision has no
    `cover_crop`;
  - `Work.media[].feed` and `Work.coverFeed` (the latter only without a cover
    crop), through `userWorkMediaSchema`.

  The contract shapes, `media_edit_key`, `work_content_sha256`, the card gate,
  Catalog, Detail and the Viewer are unchanged by r3.

- **Article shapes** keep `workMediaSchema` unchanged; Article OpenAPI
  components carry no `feed`.
- **Catalog** images never carry it.
- **Admin.** The operator submission schema embeds `mediaEditSchema`, so Admin
  parses `edit.feed` and must be rebuilt with these contracts. It has no UI
  change.

## Storage

There is no migration. `edit` is the existing JSONB of draft content, work
revision items and snapshots, so `feed` is stored wherever the edit already
travels:

- drafts and snapshot restore;
- submission and revision items;
- `readEditableWork`;
- the operator queue.

The one lossy server rebuild, `openEditDraft`, now keeps `feed`. Without that,
the first save of a framed published work would be refused
(“这件作品已有其他草稿”). `draftCovers` stays `{rotation, crop}` on purpose: it
only feeds cover thumbnails' edit keys.

On the Web:

- `setItemEdit` keeps an item's choice, stored against the new crop;
- `setItemFeed` / `MediaActions.applyFeed` are the only framing writers; they
  are silent and never reset the cover composition;
- autosave, recovery, conflict copies (`sameAuthorContent`, which compares
  effective framings) and the conflict chooser all see framing. The chooser's
  item notes (动态流整张显示 / 动态流显示局部) name only a choice that differs
  from the photo's default, so an uncropped photo shown whole adds no note.

## Rendering

- **Phone feed** (discover, 作品, 收藏, 赞; `FeedPostStage` with
  `imageFit="adaptive"`). The stage ratio rule is unchanged: photo 1's h/w,
  clamped to 1:1 … 4:5; a photo 1 at 整张 still sets it. A taller slide uses
  `object-position: 50% var(--feed-slide-y)` for 局部, or contain for 整张, with
  page-background margins.
- **Existing works** (decision 8). Their uncropped photos taller than a square
  are now read as 整张, so the feed shows them whole, and so does a work card
  whose cover passes the card gate below. Nothing stored changes.
- **Detail and the Viewer** (`imageFit="contain"`) always show the whole image
  and ignore framing.
- **Previews.** 发布's preview strip and the desktop `FeedStagePreview` render
  the same way. Card backgrounds are the page token; placeholders keep their
  muted look.
- **Cards** follow decision 4b, from `ContentCard.media.feed` (on 作品, from
  `Work.coverFeed`).
  - The card box is the cover's own shape clamped to 3:4 … 3:2, or 3:2 for a
    card that spans the whole row.
  - The framing applies only while the cover's h/w is greater than both that
    box's and the tallest feed stage's (`FEED_STAGE_MAX_RATIO`, 4:5 or 1.25),
    each with `slideFit`'s 0.001 tolerance. A card therefore follows a framing
    only when 编辑 offers the choice for that cover as photo 1.
  - A framing kept dormant from an earlier, taller crop never frames a card.
    Example: a 9:16 photo 1 set to 整张 or 局部 and then cropped to 1:1 or 4:5.
    Even a 3:2 card across the row covers that cover at the centre.
  - A card in its own clamped box only follows framing on covers taller than
    3:4, so the 4:5 test changes only the full-row card.
  - 局部 sets `object-position: 50% var(--feed-media-y)`; 整张 is contain, its
    sides on the card's own surface (`--yoyi-color-background-surface`).
  - A card without `media.feed`, a Catalog card and an inscription card render
    as before.
- **Unchanged:** 封面构图, avatar, profile cover and the article editor.

## 编辑: the 「动态流」 tool

### State machine

`feedToolState(on, window, waiting)` in `edit-stage.tsx`. `window` is
`feedStageWindow(crop ratio, stage ratio, effectiveFeed(crop.next))`, so the
default of the crop shown counts. Photo 1 uses its own stage; a later photo uses
photo 1's, and its window is unknown while that is.

| State     | When                                                   | Band                                  | Row                                                     |
| --------- | ------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------- |
| `off`     | tool off (default)                                     | none                                  | ratio row                                               |
| `pending` | on; the picture or the stage ratio is still on its way | none                                  | 正在确定动态流画幅…                                     |
| `none`    | on; the photo has no preview                           | none                                  | 这张图片暂时无法预览，不能选择动态流显示                |
| `shown`   | on; not taller than the stage                          | 动态流满幅显示 / 动态流整张显示       | 动态流中满幅显示，无需选择 / 动态流中整张显示，无需选择 |
| `region`  | on; taller, effective cover (局部; cropped default)    | 动态流显示范围, cut edges, the slider | 动态流显示 局部 ✓ · 整张                                |
| `whole`   | on; taller, effective contain (整张; uncropped)        | 动态流整张显示 · 左右留白, no edges   | 动态流显示 局部 · 整张 ✓                                |

The effective framing is the author's choice, else the default of the crop
shown: 局部 at the centre once cropped, 整张 while uncropped.

### Rules

- **The tool is a mode.** Once on, it stays on from photo to photo for this
  opening of 编辑. It also covers photos whose window is still unknown, so the
  cropper never locks by itself mid-crop. The FAB (「动态流」, `aria-pressed`)
  is disabled only while the tool is off and the photo has no window.
- **Toggling.**
  - It never toggles while a finger is on the photo or a corner.
  - Turning it on keeps the shown crop first (`crop.commit()`), so the window
    lies over the frame the feed will have.
  - Its toasts:
    - 局部: 动态流：上下拖动亮处，选择动态流里显示的部分;
    - 整张: 动态流：这张整张显示，左右留白;
    - full, no choice: 动态流：这张满幅显示，无需选择;
    - whole, no choice: 动态流：这张整张显示，无需选择;
    - off: 已退出动态流.
- **While on, the crop rests** (`cropPaused`):
  - the cropper is frozen (touch, mouse, wheel, Safari gestures and its keys),
    its focus label reads 裁剪已暂停，关闭动态流后可调整, and the corner handles
    are removed;
  - the crop field and frame stay, the thirds are hidden, and 应用到全部 is
    `aria-disabled`;
  - 旋转 and 还原 stay available and the window recomputes.
- **局部 slider.**
  - The whole frame is `role="slider"` with `aria-orientation="vertical"`,
    `aria-valuenow = round((1 − y) × 100)` and `aria-valuetext` from
    `feedRegionText` (居中，上下各裁去 n% / 上方裁去 a%，下方裁去 b%). It is
    marked `data-crop-own-control`, so the frozen cropper's key lock leaves its
    arrows alone.
  - **Finger.** A 2 px slop (a tap moves nothing). The window follows live, and
    the region is kept only once the finger lifts.
  - **Taken back.** `pointercancel`, `lostpointercapture`, window `blur`, a
    hidden page, `pagehide`, Escape (prevented before the screen's own step
    back) and the back sheet opening all take the drag back.
  - **Second finger.** It is ignored. While dragging, the stage's buttons step
    aside (`data-feed-drag`).
  - **Keys** (APG vertical slider): ↑ / ↓ ±0.05 (Shift ±0.01), Page Up / Page
    Down ∓0.25, Home = the minimum (y 1, bottom), End = the maximum (y 0, top).
    Each key is kept at once. The slider leaves ← → alone; on the stage they
    still switch photos.
- **Edges.** A band edge (and its dashed line) is drawn only where the feed cuts
  something; at y 0 only the bottom edge shows.
- **局部 · 整张** (`FeedFitBar`, the shared `SegmentRadioGroup`).
  - 整张 records the current effective region and keeps `{fit:"contain"}`
    (stored on a cropped photo only; on an uncropped one it is the default).
  - 局部 restores that region (centred if none), stored even at the centre on an
    uncropped photo.
  - 还原 clears the photo's region memory, so 局部 starts centred after it;
    its 撤销 brings the memory back.
  - Each choice is announced
    (动态流整张显示，左右留白 / 动态流显示局部，上下拖动选择显示的部分), with no
    toast and no 撤销, like a ratio.
- **还原 and 撤销.**
  - 还原 resets crop, rotation and framing (`applyFeed(key, undefined)`), so an
    uncropped photo is shown whole again. It is enabled when any of the three is
    set; a framing counts only when it differs from the default.
  - Its 撤销 restores the snapshot's pixels and then its `feed`, plus the cover
    composition rule as before.
  - The 撤销 of a turn, and of 应用到全部, gives the framing back through
    `undoneFeed`: the earlier framing while the photo still shows it, otherwise
    the framing shown now. A choice the change made the default (and so no
    longer stored) is not lost, and one chosen since stays.
- **Carried-over photos.** The band and slider lie over the still's own laid out
  box, measured from the image. 还原 resets their framing only; crop and turn
  stay off (这张图片来自早期作品，不能裁剪或旋转). Their framing is set, changed
  and reset on phone 编辑 only. The desktop item tile has never offered 编辑 for
  a carried-over photo, and this task does not add one, so the desktop dialog
  never opens for it.

### Desktop dialog (decision 4a)

- When the caller passes `onApplyFeed` and the frame is taller than the stage,
  a 动态流显示 局部 · 整张 radio group sits under the 动态流参考线 switch.
- The feed window has a 44 px handle on the bright window's right edge. It is
  the same shared slider (`useFeedRegion`): the photo inside the frame still
  pans the crop, since the desktop has no tool mode.
- 局部 · 整张 is checked from the effective framing of the crop shown in the
  dialog (`effectiveFeed`), so an uncropped photo opens at 整张.
- The choice is pending until 完成, which calls `onApply` and then
  `onApplyFeed`, only when the framing changed (compared under the crop
  that 完成 keeps). 还原 resets it to the default, and the dialog's dirty guard
  counts it.
- A pending choice travels in the dialog's edit draft (a return to the default
  as `null`): a remount resumes it, and a desktop-to-phone layout swap keeps it
  at once, as phone 编辑 keeps its own framing. Cancel discards it.
- A choice made with an unkept crop is kept for that crop: the swap stores it
  spelled out (`setItemFeedAhead`), even when it is the current crop's default,
  and the stage's `setItemEdit` stores it against the new crop once it keeps
  that crop. Otherwise 整张 with a new 3:4 crop of an uncropped photo would
  become the 3:4 crop's centred cover.
- Both the first item and later items pass the effective framing into
  `feedStageWindow`.
- Carried-over photos get no desktop entry: the tile shows no 编辑 for them, as
  before. Their framing is set on phone 编辑 only.

## Behavior Matrix

| Scenario                                  | Development                                                                     | Production (after the joint release)     | Must preserve                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| Corner crop at 原始比例                   | Drag → 自由, kept at once, re-centred and zoomed to fill the 60/16 px field     | Same                                     | Opposite corner anchored; 88 px minimum window; no 0.94 peek |
| Corner crop at a preset                   | Ratio held along the diagonal, crop snapped                                     | Same                                     | Preset label and apply-to-all eligibility                    |
| Pinch or move at 原始比例                 | A real crop switches to 自由 without a remount                                  | Same                                     | 原始比例 = crop null                                         |
| Interrupted corner drag                   | Taken back (cancel, blur, hidden page, touch elsewhere, back sheet)             | Same                                     | Interrupted pan or pinch keeps today's rule                  |
| Finger down during a commit trigger       | Settled edit kept (switch, 下一步, Back, 封面构图, reorder, 应用到全部, guard)  | Same                                     | Half a gesture never kept                                    |
| Uncropped photo, no choice                | 整张: 编辑 checks it, previews show it whole; nothing is stored                 | Existing works too: read as `contain`    | Only frames taller than 1:1 carry it; no data change         |
| Cropped photo, no choice                  | 局部 at the centre; nothing is stored                                           | Read without `feed` (a centred cover)    | 原始比例 or 还原 brings back 整张                            |
| Author's choice in 「动态流」             | Always wins; stored only when it differs from the photo's default               | Emitted unless it is a centred cover     | Uncropped 局部 at the centre is stored                       |
| 「动态流」 on                             | Crop rests, handles hidden, row → 局部 · 整张 or a note                         | Same                                     | Field and frame unchanged; 旋转 · 还原 available             |
| 局部 drag or keys                         | Region kept on lift or per key; interrupted drag taken back                     | Feed, cards and previews show the region | No 已编辑, no derivative, no readiness re-check              |
| 整张                                      | Whole photo, blank sides; 整张 → 局部 returns to the last region                | Feed, cards and previews show it whole   | Stage ratio rule (photo 1 at 整张 still sets 4:5)            |
| Photo not taller than the stage           | 无需选择 note; a stored framing stays dormant                                   | Rendered whole or full; cards centre it  | Stored framing kept                                          |
| 还原 · 撤销                               | Crop, turn and framing reset (整张 again), all back with 撤销                   | Same                                     | Cover composition rule                                       |
| 应用到全部                                | Ratio only, `aria-disabled` while the tool is on                                | Same                                     | Every photo's framing                                        |
| Carried-over photo                        | Phone 编辑 only: 局部 · 整张 over the still; 还原 resets framing only           | Legacy branches emit `feed`              | No crop or turn; display stays `base`; no desktop 编辑       |
| Desktop dialog (≥ 896 px)                 | 局部 · 整张 and a region handle in the feed window; 完成 keeps, 还原 resets     | Same                                     | No corner handles; desktop crop labels                       |
| Two-column, tablet and PC work cards      | Cover framing followed without a cover composition, if taller than box and 4:5  | Same                                     | Cover composition unchanged; dormant framing never shown     |
| Detail and the Viewer                     | Whole image                                                                     | Same                                     | Framing ignored                                              |
| 封面构图, avatar, profile cover, articles | Unchanged; 封面构图 keeps inset 0 and 3× zoom                                   | Same                                     | Their own flows and contracts                                |
| Drafts, autosave, recovery, conflicts     | Framing saved, restored and compared; chooser notes say 动态流整张显示/显示局部 | Same                                     | A framing equal to the default equals absent                 |

## Tests

- **Web, phone `edit-screen.test.tsx`:**
  - tool states (`feedToolState`), FAB, toasts and the note copy;
  - resting crop: frozen cropper, no handles, no gesture, keys held back,
    apply-all off;
  - the slider's pointer path (slop, live window, commit on lift, clamp) and
    keys (APG mapping, Shift, Page, Home/End);
  - every interruption and the second finger;
  - 局部 · 整张 with region memory and the 还原 rule;
  - 还原 · 撤销 with framing;
  - apply-all leaves framing alone;
  - photo switch and stage re-evaluation; the pending and no-preview states;
  - no toggling under a finger;
  - the legacy still;
  - CSS token and px whitelist.
- **Web, desktop `media-dialogs.test.tsx`:**
  - asymmetric bands; no zero-height edge;
  - hint copy;
  - the region handle (keys, drag, Escape, secondary button);
  - the chooser kept by 完成, reset by 还原, dirty guard, no-op when unchanged;
  - both `feedStageWindow` branches.
- **Web, data and rendering:**
  - `media-geometry` (`defaultFeed`, `effectiveFeed`, `readerFeed` and the
    crop-aware stored form), `media-order` (`undoneFeed`), `use-media-actions`;
  - drafts-format, conflict chooser and editor session;
  - readiness, runtime and preview;
  - feed-post-stage, card, profile-list, publish-screen and feed-stage-preview
    suites, including a dormant 1:1 and 4:5 framing on a full-row 3:2 card.
- **Contracts, backend and integration:**
  - schema acceptance and rejection;
  - OpenAPI drift with no Article `feed`;
  - card and work projections, including legacy;
  - the r3 read rule: an existing-style uncropped taller photo reads
    `{fit:"contain"}` on the gallery, `Work.media`, `Work.coverFeed` and the
    card; square, near-square and wide frames read no `feed`; an explicit
    centred cover reads absent; a cropped photo reads absent without a choice
    and `contain` with one; an invalid stored value falls back to the default; a
    cover composition carries none;
  - `openEditDraft` keeping `feed`;
  - pixel-only derive payloads and content hash.
- **E2E** (`tests/e2e/media-composer.spec.ts`,
  `tests/e2e/feed-framing.spec.ts`):
  - an uncropped taller photo previews whole and opens 「动态流」 at 整张;
  - a cropped one starts at 局部, centred;
  - an explicit centred 局部 previews as a centred cover and is saved as
    `{fit:"cover", y:0.5}`;
  - the desktop dialog's 还原 brings back 整张;
  - the submitted and saved `edit` follow the stored form;
  - the feed and the cards render each reader form.

Not established by these suites:

- real-device pointer capture and `lostpointercapture` on iOS Safari and the
  Android in-app WebViews;
- the six-segment row at 320–390 px;
- the reframe zoom's visual continuity.

These need the Owner's device acceptance.

## Release and rollback

- **One release.** Web, Backend and Admin must ship together, built from the
  same contracts. A Web-only release cannot carry this.
  - An old Web bundle (a stale tab) fails strict parses of cards, works and
    drafts that carry `feed`. Since r3 every read of an uncropped photo taller
    than a square carries `feed`, so this applies from the release on, not only
    once an author frames a photo.
  - An old Backend fails strict draft, editable and snapshot parses.
  - An old Admin fails the operator queue parse.
- **Rollback limits.**
  - The whole-image default is computed at read time and never stored. Before
    any author stores a choice, rolling Web, Backend and Admin back together is
    an ordinary image rollback.
  - Once one exists, every older build above rejects it. A rollback then needs
    an Owner-approved data strip of `feed` from stored edits (for example
    `edit - 'feed'` over draft content, revision items and snapshots), run with
    the usual Production data rules.
- **Pre-moderation.** A framing-only resubmission creates a new pending revision
  with an unchanged content hash. The public revision keeps the old framing
  until approval.

## Native clients

The Apple and HarmonyOS clients do not parse `feed`. They keep showing a centred
cover. Since r3 that differs from the Web for an uncropped photo taller than a
square, which the reads carry as `{fit:"contain"}`, until a client reads `feed`.
Any future client must:

- read an absent or unrecognised value as the centred cover and
  `{fit:"contain"}` as the whole image;
- send `feed` only for a work item's edit, and only as an explicit choice that
  differs from the item's default (`contain` when uncropped, else the centred
  cover);
- never send it for Article or Catalog media.
