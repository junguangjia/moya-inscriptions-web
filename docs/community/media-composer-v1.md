# Media Composer V1

Issue [#244](https://github.com/junguangjia/moya-inscriptions-web/issues/244),
phone posting flow, through r4. The Owner accepted device round 2 and authorized
P5 on 2026-10-10. Delivery stops at a Draft PR for independent review; the Owner
marks Ready and merges. This acceptance does not claim Android or a complete
browser/device matrix.

The phone flow is **start screen → 编辑 → 发布**, over the existing publishing
session. 编辑 follows the approved mockup B; 发布 follows mockup A's own publish
screen. The flow uses ArtVenn's light theme and `--yoyi-*` design tokens. The
desktop editor at widths of 896 px and above retains its existing workflow.

## Scope and preserved boundaries

This is Web presentation and interaction work. It reuses the existing picker,
upload manager, draft/session runtime, submission gate, article entry, media
edit and card-cover models. No dependency, Public Contract, Backend endpoint,
database schema or media-storage field is added. Account isolation, local
recovery, explicit draft saving, conflict protection, upload quality, limits,
Live Photo pairing and manual failure recovery remain authoritative.

The approved phone flow replaces the intermediate selected-photo grid and the
old order rail. Avatar and profile-cover editors retain their accepted flows.
Shared crop and preview helpers remain available to their existing consumers;
the article authoring editor is not replaced.

## Start screen

For a new phone work, the dock **+** opens the editor directly, without the
desktop 发布内容 chooser. The start screen offers:

- **选择照片**: opens the system album; a completed selection goes straight
  to编辑, with no additional grid or confirmation step.
- **拍照**: opens the existing camera input when available on the device.
- **专题**: uses the existing `academic-cap` icon and creates a 专题文章 draft
  through the existing article capability when it is available.
- **跳过，只发布文字**: opens 发布 for a work without photos.
- **草稿箱**: at the top right of an untouched new work, using the existing
  draft entry.

The bottom bar holds **原图画质** for the next selected photos. It remembers the
device's last choice and does not change the quality of existing photos.
Reading, account checks and article-draft creation retain the existing refusal,
busy and retry behavior. The application does not open the album automatically
on entry; the Owner withdrew the earlier picker-first requirement after the
iPhone check.

## 编辑

The current photo fills the editing stage. Each photo starts with its full
frame, labelled **原始比例**, and keeps its own crop and rotation. The ratio row
offers **原始比例 · 4:5 · 3:4 · 1:1 · 4:3**. Drag repositions the image and
pinch zooms it; rotation and 还原 keep their existing non-destructive edit
model. Changing photos or leaving 编辑 keeps the current edit without a
separate 完成 action.

**应用到全部** applies the chosen ratio once to the photos currently present.
Each eligible photo receives a crop calculated from its own rotated frame;
rotation is preserved and a photo already at that ratio keeps its position.
Unknown-size and legacy photos are left unchanged and identified in the result.
It is not a rule for subsequently added photos. The action offers 撤销, as do
rotation, 还原 and removal.

### Photo order and actions

The thumbnail strip reads right to left: photo 1 is flush right, followed by
photos 2, 3 and so on to the left. The strip alone scrolls when it overflows.
Photo 1 always has a seal-red **首图** badge. A long press and horizontal drag
reorders photos, with position numbers updating during the drag. Mouse/pen drag,
keyboard sorting, and Alt + arrows remain available; the DOM and announcements
retain logical order 1 → N.

A tap on a different thumbnail selects it. A tap on the current healthy photo
opens **设为首图 · 前移 · 后移 · 封面构图 · 移除**; 封面构图 is offered only for
photo 1, and unavailable moves are disabled. A photo needing attention opens its
existing remedy sheet instead. The current thumbnail also has a **×** removal
control, with a 26 × 32 px target; the photo sheet supplies the larger 44
px 移除 action. Removing the final photo returns to the start screen and
offers 撤销 there.

**首图 = 封面** for the new phone flow. 设为首图 moves the photo to position 1.
Reorder or removal that changes the first photo clears an incompatible chosen
cover composition and reports the reset. An older draft whose separately chosen
cover is not photo 1 retains that choice until the first position changes.

### Add, Back and save-and-leave

The strip's **+** stays outside its scroller and opens a sheet containing
**原图画质 · 选择照片 · 拍照**. It disappears at the existing item limit. The
system picker remains attached to a direct user action, including from sheets.

Back on 编辑 for a work started in this editor opens
**重新选择照片 · 存草稿并退出 · 继续编辑**. 重新选择照片 returns to the start
screen with the old photos held for 撤销. While a new pick is still being read,
reselection waits for that read to finish.

**存草稿并退出** commits the current crop and any pending removal, waits for
complete uploaded component bytes when necessary, then explicitly saves and
leaves. During the wait, the sheet shows **等待上传完成…** and **已上传 N /
M 项**. 继续编辑, Escape or browser Back cancels the wait while uploads
continue. A failed upload, save refusal or version conflict keeps the editor
open with a reason. Successful exit reports
**照片已存入草稿箱，可从草稿箱继续编辑。** A pending removal's 撤销 ends when
that removal is committed, including when the save subsequently refuses.
Derivative processing may continue after a draft save; draft saving and
publication retain their distinct readiness rules.

Opening an existing draft or published work retains the existing leave guard.
When draft saving is unavailable, the sheet offers 退出编辑 and uses that guard.
Browser Back and Escape address the topmost sheet or screen before leaving the
editor; IME composition and active pointer dragging keep their own key handling.

## 封面构图

封面构图 remains a separate screen over 编辑, with its own **完成** action and
dirty-cancel guard. It composes the card cover from the first photo's edited
frame, using the existing cover presets: **原始比例 · 3:4 · 1:1 · 4:3** in the
phone ratio order. It changes the card cover only, independently of the photo's
crop and the feed stage. Editing the underlying photo retains the existing
cover-reset semantics.

## 发布

下一步 opens the approved mockup A publish screen:

- An RTL feed preview uses the edited photos, the first photo's stage geometry,
  status chips and existing gallery limit. A photo tap returns to 编辑 for that
  item. Photos beyond the feed limit remain in the work and are identified as
  visible only on its page.
- Title and body use the existing text validation. **建议添加标题** remains a
  hint rather than a new title requirement.
- **作品性质** is an optional chip group: **原创 · 临摹或练习 · 素材分享**, with
  description and 清除选择. The latter two kinds offer
  **参考作品 · 原作者 ·来源** in a sheet. Each keystroke updates the current
  editor session; closing the sheet retains the text without a second
  confirmation.
- **可见范围** is a **公开 | 仅自己可见** segment with its existing descriptions
  and edit semantics.
- **更多操作** at the top right uses the existing 历史版本 menu when available.
- The bottom bar contains a readiness/reason line, then
  **预览 · 保存草稿 ·发布**, with 发布 in seal red. Editing an existing work
  uses 保存更新. The draft action follows the runtime's existing availability.

The publish gate is unchanged. A blocked submission explains its reason;
**前往处理** returns to the first photo needing attention and opens its remedy
sheet. Text validation returns to the corresponding field. The footer hides
while the soft keyboard is shown, and 完成 ends typing. Back from 发布 returns
to 编辑, or the start screen for a text-only work.

Reference fields update the session on every keystroke; this does not introduce
automatic Production cloud saves. Draft persistence still requires an explicit
save action under the existing publishing rules. The
separate 封面构图 screen, 建议添加标题 hint, per-keystroke reference updates,
wait-then-save behavior and thumbnail × size are retained lead decisions that
the Owner did not contradict.

## Shared helpers and article cover

`features/media-composer/crop-surface.tsx` retains the shared crop gestures:
drag, touch/trackpad pinch, Ctrl + wheel, `+ − 0` and arrow-key fallbacks, with
no zoom slider. Publishing crop sessions retain their stored area and genuine
edit intent; a mount re-report is not a user edit.

`feed-stage-preview.tsx` shares the feed's stage geometry and RTL scroll-snap
presentation. `feedStageWindow` in publishing's media geometry describes the
centred visible window without storing a new crop. 编辑's **动态流参考线**
starts off; enabling it explains the visible window. The shared edit presets
include 4:5 for existing crop consumers, including article body images.

`article-cover-preview.tsx` continues to show the selected article cover in the
existing 1:1 compact-card and 16:10 large-card boxes in 文章设置. It stores only
the existing `coverRefId`; no article-cover crop field is introduced.

## Behavior Matrix

| Scenario                          | Development                                                                        | Production                                                             | Must preserve                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Phone dock +, new work            | Start screen directly; 专题 and 草稿箱 when available                              | Same presentation when the existing publishing capability is available | Authentication, account checks and desktop chooser                         |
| Select or capture photos          | System picker/camera → 编辑 without a selected-photo grid                          | Same                                                                   | Accepted formats, quality choice, item limits and Live pairing             |
| Crop one photo                    | Full-frame default; independent ratio, position and rotation                       | Same                                                                   | Non-destructive `MediaEdit`, stored crops and local recovery               |
| 应用到全部                        | One-time ratio application with per-photo geometry and 撤销                        | Same                                                                   | Rotation, existing same-ratio position and unsupported-photo handling      |
| Reorder and 首图                  | RTL strip, drag/keyboard/sheet actions; first photo badge                          | Same                                                                   | Logical order, current-photo identity and cover reset rule                 |
| Remove or reselect                | Immediate visual removal; 撤销; empty album returns to start                       | Same                                                                   | Cancelled-upload ownership, correct focus and no stale 撤销                |
| Add more photos                   | + sheet: quality, album and camera; existing limit enforced                        | Same                                                                   | Existing photos and their quality remain intact                            |
| Back from new-work 编辑           | Reselect / save-and-leave / continue sheet                                         | Same where draft saving is available                                   | Existing leave guard for drafts, works and unavailable saving              |
| 存草稿并退出 during upload        | Progress wait, explicit save, then exit; cancel wait or remain on failure          | Same                                                                   | Complete uploaded bytes, conflicts, newer edits and no implicit cloud save |
| 封面构图                          | Separate first-photo card-cover screen, 完成 and dirty-cancel guard                | Same                                                                   | Existing cover model; photo crop and feed window remain independent        |
| 发布                              | Mockup A chips, visibility segment, reference sheet, menu and footer               | Same where available                                                   | Existing text rules, visibility semantics and submission readiness         |
| Preview and media failures        | Feed geometry, gallery-limit note, truthful statuses and remedies                  | Same                                                                   | Existing resolved media sources; no synthetic fallback for real media      |
| 专题 and article cover            | Existing article-draft entry and two cover-card previews                           | Existing capability gate retained                                      | Article editor, `coverRefId` and account isolation                         |
| Keyboard, Back and layout swap    | Topmost sheet handling, keyboard-aware footer, session/crop retained across 896 px | Same                                                                   | IME handling, focus restoration, reduced motion and one editor session     |
| Desktop, avatar and profile cover | Existing workflows retained                                                        | Same                                                                   | Accepted desktop editor and profile image flows                            |

Development sign-in and synthetic acceptance fixtures remain Development-only.
They do not authorize Production sign-in, publication or deployment.

## Validation

Colocated tests cover the phone start screen, edit stage, RTL thumbnail strip,
crop/apply-all geometry, sheets, cover rule, publish options/footer and editor
session guards. Shared crop, feed-preview, media-dialog, media-geometry and
article-cover suites preserve their existing consumers.

`tests/e2e/media-composer.spec.ts` targets the current phone start
→ 编辑 → 发布 flow, including direct album handoff, RTL order, photo actions,
crop and cover separation, add/Back sheets, explicit save and article entry. E2E
uses a task-owned Development stack with synthetic fixtures. Every action is
guarded by a visibility assertion; use the line reporter, a private log and a
stall monitor because this repository's Playwright configuration has no default
timeouts. Record bounded-run failures as failures, not acceptance.

Run the task's cumulative `scripts/verify-task.mjs` gate against its approved
base, including applicable lint, typecheck, tests and build. Automated phone
emulation does not establish native album/camera, physical gestures, iOS
keyboard or Android acceptance. The Owner's device acceptance and independent
review remain separate evidence.

## Deferred

- Stored article-cover cropping, which requires separate contract/backend scope.
- Byte-level progress for profile images under the separately authorized media
  pipeline work.
- Broader device/browser acceptance and further visual refinements beyond the
  accepted phone flow.
