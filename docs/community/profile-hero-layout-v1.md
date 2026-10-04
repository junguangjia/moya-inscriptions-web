# Profile hero layout V1

Status: implementation candidate (task `profile-hero-layout-v1`). Owner visual
acceptance, Ready, merge and Production publication are separate.

The Owner reported that the profile page (个人主页) wasted most of its first
screen. The avatar, name and actions sat centred over the middle of the cover,
and the 屏蔽 / 私信 buttons used the generic boxed `.phase4-actions` style,
which does not match the rest of the product. The cover photo should be the main
thing on the page.

This task changes how the Web profile header is presented. It makes no API,
Contract, database, storage, upload-limit or dependency changes.

## Layout

Revision 4 follows the Owner's comparison in the simulator (2026-10-04):

- the short shade of the dark version they chose;
- a shade in the photo's own tone;
- a collections stage whose identity cannot be scrolled away, with the photo
  shrunk to a compact cover that stays behind the identity.

Revision 5 (Owner, same day): the compact cover shrinks further, and its
background becomes frosted glass made from the reader's upload.

Revision 6 (Owner, on a real iPhone): the full-cover frost "loses the texture
completely". Four texture-preserving treatments were prototyped on the live page
in a WebKit lab, against six covers (the Owner's stone, a carved stele, a stone
macro, bright paper, a vivid sky, black basalt), and judged on design and on
engineering. The glass card won: the sharp photo stays visible, and the identity
sits on a card of frosted glass.

| Treatment           | Texture kept (stone / stele / macro) | Reads as glass |
| ------------------- | ------------------------------------ | -------------- |
| Rev. 5 full frost   | 0.02 / 0.02 / 0.07                   | yes            |
| Smoked (no blur)    | 0.49 / 0.46 / 0.52                   | weakly         |
| Etched (high-pass)  | 0.48 / 0.46 / 0.63                   | partly         |
| Progressive frost   | 0.74 / 0.74 / 0.73                   | partly         |
| Glass card (chosen) | 0.84 / 0.84 / 0.84                   | yes            |

- **The whole first screen is the photo.**
  - With a photo, the cover (`[data-profile-background-slot]`) is at least
    `100svh` and runs up under the top bar, so the collections stay out of
    sight.
  - The photo stays sharp and sinks only under the identity, through a short
    eased shade (176 px), into its own dark tone.
    - That tone (`--cover-shade-photo`) is the average of the photo's lower
      part, sampled on a canvas and darkened until its luminance is at most
      0.016. So the dark theme's text, including the seal-red counts, reads at
      4.5:1 or more whatever the photo.
    - Transparent areas of a photo show `paper-dark` in either theme, and are
      sampled as such. Before sampling, and when sampling fails, the tone falls
      back to `paper-dark`.
  - The identity's text, the top bar and the pencil wear the real dark theme
    (`data-theme="dark"`, which the tokens scope to any subtree) in both stages,
    because the photo is always behind them. The avatar does not: the avatar
    editor dialog opens inside it, in the reader's own theme. Over a photo the
    avatar ring takes the shade's colour; without one it keeps the page colour.
- **Two resting places.**
  1. The photo, at 0.
  2. The collections, as a compact cover: the sharp photo, with the identity
     resting 12 px under the top bar on a glass card made from the photo (see
     below). The tabs follow 16 px under the actions, edge to edge in the page
     colour, below a fine bevel.
  - The photo cover is `position: sticky` with a negative top (`--cover-rest`).
    At the second resting place the compact cover, identity and tabs (sticky at
    `--cover-pinned`) stay where they are, and only the collections scroll. The
    identity cannot be scrolled away.
  - The identity's bottom padding keeps the photo stage clear of the dock and
    the scroll hint. In the second stage the tabs slide up over it, so the
    resting place sits that much further down. That padding then lies over the
    collections below the tabs, clear and transparent to input: only the cover's
    own controls take taps.
  - An identity too tall to pin while leaving 160 px of collections (a long bio,
    a landscape phone) scrolls freely instead (`data-cover-free`). Its bar then
    turns solid as before, in the reader's own theme.
  - A vertical drag, wheel turn or scrolling key that settles between the two
    places glides on in its direction.
  - A glide cut short (a tap, a sideways swipe, a scroll write) settles on in
    its direction, once.
  - Taps, horizontal pager swipes, keys typed into fields or pressed on buttons,
    input inside nested dialogs and restored positions never start a glide. With
    reduced motion the jump is instant.
- **A scroll-linked transition.**
  - `--cover-progress` (0 photo, 1 collections) and `--cover-scroll` are written
    to the DOM on scroll.
  - The photo stays put while the identity rises over it: its box is the part of
    the cover still on screen above the tabs (`--cover-scroll`), down to the
    compact cover. The image keeps its full-cover size (`--cover-height`), so
    the photo crops to its top part instead of zooming out.
  - In the last 8% of the way, as the identity lands, its shade hands over to
    the glass card, which fades in where the identity rests. The card never
    moves; only its opacity follows the scroll.
  - The page behind the collections turns from the photo's shade into the
    reader's page colour.
  - At halfway the scroll hint leaves, Safari's bottom strip changes and the
    identity's text all takes the primary colour.
  - Over a pinned photo the top bar stays clear; the photo is always behind it.
- **Glass card.** In the collections stage the identity sits on a card of
  frosted glass made of the reader's own photo, over the sharp photo, so the
  photo's texture stays crisp around the card and soft through it.
  - The card wraps the identity's resting place by 10 px, 20 px rounded, placed
    from the layout (`--cover-card-top/left/right/height`).
  - Its frost is the photo laid out exactly as the sharp image, over the photo
    box's dark paper (so a transparent photo frosts too), blurred 5 px
    (`filter`, no `backdrop-filter`) and clipped to the card.
  - On top sit a tint in the card's own darkened colour, a faint top sheen, a
    rim catching the light from the top left, an inner highlight and a soft
    shadow. A fine bevel closes the photo above the tabs.
  - The tint's opacity (`--cover-card-alpha`) is sampled per photo, after the
    image decodes and once the layout settles. The photo under the card is
    blurred as the CSS blurs it, and every laid-out line of the identity's text
    is measured (a short name is a short box). The opacity is the thinnest (at
    least 0.18) under which the brightest point of the glass behind every line
    stays at luminance 0.115 or less. So all of the identity's text, which takes
    the dark theme's primary colour there, reads at 4.5:1 or more, even over a
    bright carved stroke.
  - A photo already that dark behind the text gets a faint milky frost instead.
  - Until sampling finishes, if it fails, or if the photo draws blank, a default
    tint of 0.8 holds for any photo, pure white included.
  - Measured in the lab on seven covers (the six above plus white carved strokes
    on grey), at the brightest point behind each line: name 4.87–9.27:1, smaller
    text 4.72–8.87:1.
  - The photo box isolates its layers, so the card stays under the identity.
  - Reduced transparency and increased contrast get a solid card instead.
  - This is an Owner-requested treatment of the reader's own upload. It is not
    the Functional Glass material of ADR 0007: no shared glass class or
    parameters, and no blur over other content.
- **Scroll hint.**
  - A small chevron at the foot of the photo fades in and floats three times,
    every time the reader is back on the photo.
  - Tapping it makes the same glide and moves focus to the active collection
    tab. Its name follows that tab.
  - Its hit area is 44 px. It is `inert` while the collections show, and hands
    focus on first.
- **Safari's bars continue the photo** (iOS 26, verified in the iOS 26.5
  Simulator). A web page cannot draw under them; Safari paints them from page
  CSS.
  - **Status bar:** the sticky top bar carries the photo's top-edge colour as
    `background-color` with `background-clip: text`, so it paints nothing
    itself. The photo's top edge melts into it.
  - **Strip under the bottom bar:** a fixed, text-clipped chin carries the
    photo's shade over the photo, and the page colour after. A free cover
    carries the shade for as long as the identity covers the bottom edge.
    - Safari reads that strip when a fixed element appears, not when a colour
      changes mid-scroll. It reads the topmost layer at the edge.
    - So the chin sits above the scroll hint, takes no input, and is re-inserted
      when the stage or the shade changes and scrolling rests.
  - `theme-color` is ignored by Safari 26.
- **No photo, compact header.** Without a photo the header keeps the same
  left-aligned identity just under a solid bar, in the page theme. It reserves
  no cover area and does not glide; its tabs pin under the bar as before.
- **Owner pencil.** 编辑主页背景 sits below the bar, in the same column as
  the 设置 icon.

## Actions

The actions reuse the publishing pills (`media.module.css`), the Owner-approved
style from #171; over the photo they take the dark theme's colours. They are
compact here: 34 px to the eye, still 44 px to the finger through a hit-area
pseudo-element. The 关注 pill carries a soft seal-red shadow:

| Control                        | Presentation                                  | Behaviour (unchanged unless noted)                                                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 关注 (not following)           | Seal-red primary pill                         | `relationships/follow` enabled, `aria-pressed="false"`                                                                                                                                                                                   |
| 取消关注 (following)           | Quiet surface pill with a border              | `relationships/follow` disabled, `aria-pressed="true"`                                                                                                                                                                                   |
| 私信                           | Quiet surface pill                            | Opens the message center on the pair and closes the profile; sends nothing                                                                                                                                                               |
| 屏蔽                           | Moved into a ⋯ 更多操作 menu, in error colour | **Changed: one more tap.** The same `window.confirm` copy, then `relationships/block`, then the profile closes. The menu follows the composer's 更多操作 menu: focus moves to the item, Escape returns focus, an outside press closes it |
| 关注 N / 粉丝 N                | Plain text buttons, count in seal-red         | Open the people lists                                                                                                                                                                                                                    |
| 登录后关注 / 登录 (signed out) | Seal-red primary pill link                    | Same sign-in destination                                                                                                                                                                                                                 |

All controls are at least 44×44 px.

## Scroll and collapse

The cover overlaps the top bar (`margin-bottom: -bar` on the bar). The tabs
therefore pin after scrolling the cover's height minus the bar's, not the full
cover height. `changeTab` and the resize correction both use this threshold
(`coverCollapse`). The maximum scroll of an empty collection still equals the
threshold, so every collection can pin.

## Background editor

The editor keeps the #171 model: one 4:3 master, top-anchored, shown in context.
What changed is that it now **measures** the owner's header instead of copying
the header CSS by hand:

- the cover box;
- the identity panel's top;
- the avatar box;
- the name's position and font size;
- the round controls over the cover: top-bar icons and the pencil.

A header without a photo is measured once at the photo geometry, using the
`data-cover-measure` flag inside the same synchronous read, so nothing paints in
between.

`HeaderGhost` draws the same `.coverPanel` fade, scaled through `--cover-px`, so
the live page, the overview replica and the crop window cannot drift apart.

Measured reference headers (own profile, one-line bio):

| Device                   | Cover   | Panel top | Avatar    | Name              |
| ------------------------ | ------- | --------- | --------- | ----------------- |
| Phone 390×844            | 390×844 | 477.6     | 16, 573.6 | 108, 587.7; 24 px |
| Desktop 1280×800 (cover) | 960×800 | 433.6     | 16, 529.6 | 108, 538.9; 32 px |

The safe area is now **master x 0.34–0.66, y 0.16–0.39**. It is inside the
window, clear of the top-bar icons and the pencil, and above the identity panel
for:

- portrait phones from 360 px wide and tablets, with bios of up to three lines;
- desktop windows from 1366×657 with a bio of up to one line.

Landscape phones remain best effort. The guide copy now
says 「重要内容请放在小框内」and 「重要内容放在画面中部偏上」.

## Behavior Matrix

Production keeps no Community exposure (`/api/community/*` returns 404), so the
profile page is unchanged there in every scenario.

| Scenario                                       | Development                                                                                                                                                                      | Production | Must preserve                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------- |
| Profile with a photo, at the top               | The photo fills the first screen; the identity sits bottom-left on its own dark shade; a chevron hint floats at the foot                                                         | Unchanged  | Profile data, follow / message / block behaviour, navigation and Back |
| Glide to the collections                       | A drag, wheel turn or key glides to the second resting place: the sharp photo with the identity on a frosted glass card, tabs pinned below; the identity cannot be scrolled away | Unchanged  | Per-tab scroll offsets, tab switching, pager swipes                   |
| Identity too tall to pin (long bio, landscape) | The cover scrolls away freely; the bar turns solid in the reader's theme                                                                                                         | Unchanged  | Collections stay reachable                                            |
| No photo                                       | Compact left-aligned header in the page theme; no cover, hint, card or glide                                                                                                     | Unchanged  | Existing profiles without a background                                |
| Own profile                                    | 设置 in the bar, the background pencil below it, the avatar opens its editor in the reader's theme                                                                               | Unchanged  | Avatar and background editors, their save and limits                  |
| Visitor actions                                | 关注 / 取消关注 and 私信 as compact pills; 屏蔽 behind ⋯ 更多操作 with the same confirmation                                                                                     | Unchanged  | The same commands, confirmations and copy                             |
| Signed out                                     | 登录后关注 pill to the same sign-in destination                                                                                                                                  | Unchanged  | Sign-in return                                                        |
| Background editor                              | Overview and crop window measure the live header; safe area x 0.34–0.66, y 0.16–0.39                                                                                             | Unchanged  | 4:3 master, top anchor, upload limits, save flow                      |
| Reduced motion / transparency, more contrast   | Instant jumps; a solid card instead of glass                                                                                                                                     | Unchanged  | Readable text everywhere                                              |
| iOS Safari bars                                | Status bar and bottom strip continue the photo, then the page                                                                                                                    | Unchanged  | Other browsers keep their own bar colours                             |

## Known trade-offs

- A full-screen phone cover shows a narrow part of the 4:3 master: about 35% of
  its width at 390×844, down from 51%. Phone covers from a 1600 px master are
  therefore noticeably softer at 3×. The export sizes, upload limits and the 4:3
  decision from #171 are unchanged. A wider master, or a separate portrait crop,
  would be a separate decision.
- The status-bar tint depends on Safari 26's sampling behaviour, which is not a
  web standard. Other browsers keep their own status-bar colour.
- The base `.header`, `.profile` and `.identity` rules are unchanged, because
  the QA prototype (`/dev/t02p/qa`) shares them. The new rules are scoped
  `cover*` classes.
