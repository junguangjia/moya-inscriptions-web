# Profile cover upload redesign V1

Status: implementation candidate for Issue #171 r4. Delivery stops at an
independently reviewed Draft PR with a Development preview. Owner visual and
physical-device acceptance, Ready, merge and Issue closure are separate.

The Owner reported that background upload was hard to use, especially the crop
shown after a photo is chosen. This task redesigns select → crop → preview →
save → display for the Web profile cover. It does not redesign the profile page;
the avatar editor changes only as r4 records (below). It makes no API, database,
storage or dependency changes.

## Recorded defects before the change (AC1)

Recorded on `c0742e9` in the Development stack, at phone (390×844, 3×) and
desktop (1280×800) sizes. The screenshots and recordings are private task
evidence. Ranked by impact:

1. **Crop frame and header do not match.**
   - The editor cropped to 16:9.
   - The header is a full-bleed cover behind the identity. Its measured aspect
     is 0.72 at 390×844 (portrait) and 1.81 at 1280×800. Aspects range from 0.63
     to 2.1 across viewports and bio lengths.
   - Phones therefore showed about 38% of the framed width.
   - There was no visualisation of what each device shows, of the fade, or of
     where the avatar and name sit.
2. **Many camera photos were refused.** The avatar's source limits applied: 4
   MiB and 16 Mpx. A 24 MP phone photo was rejected with 「请选择不超过 4
   MiB…」.
3. **Soft images on high-density phones.** A fixed 1280×720 export was upscaled
   about 2.4× at 3×. Small crops were also upscaled.
4. **No progress indication.** One label covered two sequential requests.
   Uploads use `fetch` with a 15 s budget.
5. **Raw browser or server text could surface**, for example "Failed to fetch",
   or an English 409 message.
6. **Weak affordances.**
   - The picker took two taps. The overview step is kept by the r2 decision, but
     it now previews the current background and makes 更换照片 its primary
     action.
   - The pencil had no backing over photos.
   - 选择照片, 恢复空白背景 and 保存背景 had equal weight.
   - There was no explicit Cancel, reset or reselect.
   - Leaving used `window.confirm`, while the avatar precedent (`b7bbb25`)
     closes with no prompt.
7. **Orphan re-uploads on retry.** The cropper re-reports its area on resize.
   Each re-report cleared the retry intent, so a retry after a failed save
   uploaded another copy.
8. **A save could be aborted on focus return.** Returning focus to the window
   (for example after the file picker) re-checked the session and aborted an
   in-flight save.
9. **Stale touch listeners.** react-easy-crop has no `touchcancel` handling.
   After a cancelled gesture, a later touch anywhere moved the photo. This is
   reproduced in `tests/e2e/profile-cover.spec.ts`.
10. **Wheel and trackpad input was captured.** Ordinary two-finger scrolling
    over the crop zoomed the photo.
11. **Old background shown under the success message.** The notice appeared
    while the header still showed the old background.

## Framing model

The saved background is one derived **4:3** PNG (the master).

The live cover keeps its accepted full-bleed layout, with a single CSS change:
`object-position: 50% 0`. Every header therefore shows a window of the master
that starts at its top edge:

- **Portrait headers** show a centred, full-height strip: 47–65% of the width on
  phones.
- **Wide headers** show the full width from the top: 64–97% of the height on
  desktops.

The editor frames the master and draws, from the owner's measured header:

- the window this device shows, with everything outside it dimmed;
- the live cover fade (the same CSS rule as the header);
- the avatar, name and owner-only pencil where the header places them;
- the other device's window for reference;
- a **safe area**: master x 0.27–0.73, y 0–0.22.

The safe area is visible and above the fade in these cases:

- portrait phones from 360 px wide with bios of up to three lines;
- tablets;
- desktop windows from 1366×657.

Landscape phones and very long bios are best effort. The hint
says「不同机型显示范围略有差异」.

This follows YouTube's nested banner safe areas. It also follows the one-master,
per-device-window model used by WeChat, Weibo, Douyin and Xiaohongshu.

Existing Development backgrounds are 1280×720. They render top-anchored and
shift only where the header is wider than 16:9: about 2–7% on short desktop
windows and 13–16% on landscape phones. They are never re-cropped.

## Flow

The editor stays inside the existing `AuthorDialog`, with no new shell or
motion. Back never shows a discard prompt, and it is blocked only while a save
is in progress.

| Step (dialog depth)     | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview (0)            | 手机/电脑 as the 设置 underline tabs, then the current background in a header replica built from the live cover classes. Buttons: 移除背景 (secondary) and 更换照片 / 选择照片 (primary).                                                                                                                                                                                                                                         |
| Choose                  | Opens the system picker from the click. An unusable file gets specific copy. A failed reselect keeps the current photo and crop.                                                                                                                                                                                                                                                                                                  |
| Crop (1)                | 手机/电脑 tabs above the 4:3 frame. Drag to reposition; zoom with two fingers (touch pinch or trackpad pinch); there is no zoom bar (r3). Fallbacks: arrow keys (8 px), `+ − 0`, Ctrl + wheel. Under the frame: 还原 and the gesture hint, then the 参考线 switch, then 重新选择 / 保存. Back (header or swipe) returns to the overview; there is no separate 取消. The zoom range is 1–3, and the image always covers the frame. |
| Saving                  | 处理图片 · 上传 · 保存 · 更新主页. Input is locked. The dialog closes, and the notice appears, only after the owner's header shows the confirmed image, or after 15 s with 「刷新后显示」.                                                                                                                                                                                                                                        |
| Failure                 | Mapped copy that says whether the background changed. 重试保存 reuses the exported bytes and both request ids. A changed crop starts a new export. After a save with no definite answer, leaving the step (or closing) checks the profile once: only a background that really changed refreshes the header, with 主页背景已保存.                                                                                                  |
| Remove confirmation (1) | A blank replica. Buttons: 取消 (secondary) and 确认移除 (primary), which saves `mediaId: null`.                                                                                                                                                                                                                                                                                                                                   |

## Behavior Matrix

| Scenario                      | Development                                                                                                                                                                                                                                                                             | Production                       | Must preserve                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| Owner opens the editor        | Overview with a header replica and a device toggle                                                                                                                                                                                                                                      | Unchanged: no Community exposure | Owner-only entry, dialog history ownership                                                    |
| Choose a photo                | The crop state appears immediately; zero requests                                                                                                                                                                                                                                       | Unchanged                        | Backend PNG validation; avatar limits (background source: JPEG/PNG/WebP ≤ 25 MiB, ≤ 50 Mi px) |
| Crop, reposition and zoom     | 4:3 frame with device window, fade, identity and safe area; the gesture stays inside the frame; bounded zoom, no blank areas                                                                                                                                                            | Unchanged                        | Native scrolling outside the gesture                                                          |
| Cancelled gesture or blur     | The gesture ends and the position is kept                                                                                                                                                                                                                                               | Unchanged                        | —                                                                                             |
| Save                          | One export, one upload, one bind; visible phases; closes after read-back                                                                                                                                                                                                                | Unchanged                        | Ownership, media authorization, idempotent request ids                                        |
| Failure                       | Truthful mapped copy; photo, crop and ids kept                                                                                                                                                                                                                                          | Unchanged                        | Persisted background untouched until the bind succeeds                                        |
| Back, cancel, reselect        | Steps back without a prompt; never writes; repeated loops settle                                                                                                                                                                                                                        | Unchanged                        | Previous persisted background remains intact; profile navigation and URL                      |
| Remove                        | Explicit confirmation step, then `mediaId: null`                                                                                                                                                                                                                                        | Unchanged                        | —                                                                                             |
| Existing backgrounds          | Top-anchored; the pencil has a translucent backing                                                                                                                                                                                                                                      | Unchanged                        | Accepted profile layout                                                                       |
| Reload                        | The server bytes render through the same CSS the editor previews                                                                                                                                                                                                                        | Unchanged                        | Existing profile data                                                                         |
| Narrow phone / short viewport | The height-capped 4:3 frame, tools, switch and actions fit a 360×640, 375×667 or 393×659 viewport without scrolling; on the smallest phones with browser toolbars showing, the dialog scrolls and every control stays reachable; landscape phones use two columns; controls are ≥ 44 px | Unchanged                        | Native scrolling outside the crop gesture; safe-area insets                                   |
| Reduced motion or keyboard    | No animation dependency; keyboard crop and zoom (browser Ctrl/⌘ shortcuts untouched); focus follows each step                                                                                                                                                                           | Unchanged                        | Focus and accessibility behaviour                                                             |

## Image architecture (AC9)

The existing architecture is kept. The Backend accepts only derived, bounded PNG
media and stores no crop metadata. The client:

1. decodes the chosen photo once, applying EXIF orientation;
2. bounds that decode to 16 Mi px, correcting engines that resize before
   rotating;
3. draws the 2048 px display copy from those decoded pixels;
4. resamples the chosen area once, with high-quality smoothing, into the widest
   width that fits: 1600, 1440, 1280 or 1024 px.

The export is never wider than the area's source pixels. It is lossless PNG,
converted to sRGB with metadata stripped. The target is under 3 MiB, so it fits
the unchanged 15 s request budget, and the hard limit is 4 MiB. Opaque images
are saved as RGB. A stored background is never re-cropped. Changing the framing
means choosing the photo again.

Replaced or abandoned uploads remain owner-only `user_media` rows, as before.
Collecting them is Backend scope.

## Visual language (r4)

The editors use ArtVenn's established controls; nothing new is invented:

- **Actions:** the publishing crop dialog's buttons and layout
  (`publishing/ui/media/media.module.css`): the primary action is a seal-red
  pill (`--yoyi-color-seal-red`, `text-inverse`, 15 px / 650), secondary actions
  are outlined pills, and every step ends in a two-button row.
- **Device choice:** the 设置 underline tabs (`.phase4-settings-tabs`), selected
  with the seal-red underline.
- **参考线:** the composer's switch (`EditorSwitch`), whose description replaces
  a legend.
- **Notes, errors and progress:** `dialogNote`, `notice` / `errorText` and the
  composer's step bars.
- **Guides over the photo:** palette tokens only, the same in both themes: an
  ink-black 55 % dim outside the device window, a paper-light 1 px edge, a
  dashed edge for the other device and a solid one for the safe area.
- **Avatar editor (r4):** the same two-finger zoom (shared `crop-gestures.ts`),
  the same 还原 and hint row (`crop-tools.tsx`), and the
  seal-red 保存头像 primary. Sharing the cover's input also brings: an 8 px
  arrow step (was 1 px), a plain mouse wheel no longer zooms (Ctrl + wheel or
  trackpad pinch does), and no long-press or right-click menu on the photo. The
  durable save, the daily limit, picker-first entry and Back without a prompt
  are unchanged.

## Reused mature components

- **react-easy-crop 6.2.3**, the existing dependency. Mastodon's 2026 profile
  editor and Open Collective's hero cropper use the same version.
- **Mastodon's lessons:**
  - #39957 / #39958: cap the export size;
  - #38433 / #38446: use the same anchor in the editor and on the page.
- **Keyboard alternatives** to drag and pinch (arrow keys, `+ − 0`, announced
  through the crop area's label). By Owner decision (r3) there is no on-screen
  zoom bar: touch users zoom with two fingers, and a touch screen-reader or
  single-pointer user cannot zoom (they keep drag and 还原). The Owner accepted
  this trade-off.
- **GitHub `image-crop-element`:** key map.
- **Repository code reused:**
  - `AuthorDialog` navigation depth;
  - `normalizeAvatarPng`;
  - the publishing bounded preview and WebKit blank-canvas guards.

No dependency was added.
