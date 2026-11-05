# Web phone feedback V1

Status: Owner phone acceptance complete; authorized for protected merge and
remote delivery.

Later change: home-timeline-v1 (Issue #384, 2026-11-03) replaced the Nearby feed
with 时间轴 at the same index. Mentions of Nearby below record the feed as it
was in these rounds. Their four-feed, motion, keyboard and reduced-motion rules
now apply to the timeline tab.

The Owner's four annotated phone screenshots on 2026-09-20 authorize these
specific changes to the existing React application. This is a local reviewable
preview task; it does not authorize Production deployment, a historical data
purge, or modification of another task's running services.

## Scope

Home card layout and official Catalog province labels; personal profile layout,
profile background persistence, profile actions and relationship lists;
permanent user-facing deletion. Necessary public shapes, backend adapters,
additive migrations, runtime grants and focused tests belong to this scope.
Authentication providers, administrative workflows, recommendation ranking,
Catalog facts, Detail/Viewer gestures and unrelated agent administration remain
unchanged.

## Behavior matrix

| Scenario                        | Development                                                                                                                                                           | Production                                         | Must preserve                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| Extreme image proportions       | Crop centered into bounded card media, keeping the original in Detail                                                                                                 | Same presentation on eligible public cards         | Media bytes, identity, data order, full-image viewer                             |
| Official Catalog card           | Translucent province label at upper right when known                                                                                                                  | Same authoritative province projection             | No invented province and no label on user works                                  |
| Two-column Home feed            | First card spans both columns; subsequent spanning cards appear when both column bottoms align after ordinary cards                                                   | Same layout where the feed is composed             | No duplicated/reordered records; single-column and desktop policies              |
| Own profile                     | Center identity below a cover region; edit information, background and comments available on profile                                                                  | Existing community composition remains unavailable | Existing settings, privacy, account isolation and Back behavior                  |
| Profile background              | Explicit save uploads bounded owned media and persists the chosen cover; remove restores blank cover                                                                  | No new community exposure                          | No credentials in browser state; existing avatar unaffected                      |
| Following / followers           | Dedicated lists with avatar and name; own following supports unfollow, own followers supports block; select multiple or all with explicit action and per-item results | No new community exposure                          | Others' list privacy, genuine server results, no automatic mutation on select    |
| User deletes work/draft/comment | Explicit confirmation means permanent content removal; no recycle bin or restore operation                                                                            | No new community exposure                          | Ownership checks, idempotency, other users' reply relationships and shared media |
| Existing trash content          | No automatic purge or migration of content during this implementation                                                                                                 | No deployment or purge                             | Existing Owner data and historical evidence                                      |

## Validation and delivery

Use isolated task worktrees and task-owned disposable validation databases. Run
focused tests during implementation, then lint, typecheck, relevant backend and
PostgreSQL tests, and applicable builds under the explicit validation profiles.
Independently review the actual integrated diff. A passing local check does not
replace Owner phone acceptance, hosted CI or protected delivery.

## Owner feedback round 2 (2026-09-20)

The later five annotated screenshots supersede the earlier profile action
placement and navigation arrangement. The Owner clarified that the middle
primary destination is Discussion (讨论) and My Comments belongs to Messages.

Home now owns Discover, Nearby, Inscriptions and all Calligraphy. Discussion
owns News, Threads (empty presentation shells) and existing Topics. User owns
the existing profile. A fixed message icon opens a presentation-only message
center with a functional My Comments entry. Primary labels use Song serif text;
selected top-tab icons animate with pager progress. Profile cover space is at
least half a viewport, identity overlays it, numeric relationships use the
existing accent, background edit is an icon, and information editing is in
Settings. Detail count projection, carousel indicator progress, share bounds and
per-tab scroll preservation are included in this round's authorized scope.

Preserve prior permanent deletion, relationship lists, background persistence,
Catalog filters/paging, content identity and existing preview database records.
Validate actual counters and navigation/Back behavior, and independently review
the integrated R2 diff before refreshing the local phone link.

## Owner phone feedback round 3 (2026-09-20)

Bounded acceptance fixes authorized by the two phone screenshots: preserve a
shared profile-header collapse across Works, Favorites, Likes and History; allow
empty tabs to scroll until the common tab row is pinned; restore the cover and
identity by scrolling back to the top. Fix flickering Home category icons during
horizontal paging and show the entire Nearby icon. Existing data, relationship
actions, navigation and individual content offsets remain intact. No API,
database, dependency or production changes belong to this round.

| Scenario                          | Development                                                                   | Production                          | Must preserve                                                  |
| --------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| Empty or short profile collection | Enough scroll extent to hide cover/identity; tabs pin beneath Back/Settings   | Same where the profile is available | Truthful empty state; no fabricated content                    |
| Profile tab click or swipe        | Preserve shared header expansion; retain per-tab body offsets while collapsed | Same where available                | Existing pager, account isolation, Back and detail restoration |
| Scroll profile to top             | Cover and identity reappear naturally                                         | Same where available                | Existing background and avatar                                 |
| Home category transition          | One continuous icon/underline animation; full Nearby icon bounds              | Same                                | Existing four feeds, keyboard access and reduced motion        |

Delivery remains the existing local phone preview after focused regressions,
lint, typecheck, applicable build and independent incremental-diff review.

## Owner phone feedback round 4 (2026-09-20)

The three new annotated screenshots authorize these incremental presentation
changes. Detail Information and Comments share the media-header collapse,
including empty comments; horizontal switching preserves the pinned tab row and
independent body positions. Scrolling to the top reveals media again. Phone
media fills the available width without an outer card, radius or shadow, while
retaining the full uncropped image and Viewer. Dot/action/tab spacing is
reduced. Home tab animation must follow the stable Discussion transition
behavior and retain all four feeds and existing icons. The Messages trigger
supports an accent-orange unread badge: hide zero and cap displayed values at
99+.

Messaging remains presentation-only as authorized in round 2. The unread count
is a supplied presentation input, defaults to zero, and is not fabricated or
backed by a new notification service. No database, API, dependency, publishing,
production or other unrelated work belongs to this round. Validate empty and
long Detail tab transitions, restored expansion, carousel/Viewer behavior and
Home animation in browser engines; retain failures and independent diff review.

## Owner phone feedback round 5 (2026-09-20)

The Owner clarified that the original Discussion animation must be preserved.
Restore its continuous pager-driven icon opacity, size and label movement; Home
uses that same motion while retaining its isolated header progress updates so
populated feeds do not rerender on every swipe frame. The round 4 committed-only
icon fade is superseded. Preserve full Nearby glyph bounds, keyboard behavior,
reduced-motion handling and existing feed navigation.

Phone Detail previews use a stable width:height ratio of 3:4, edge to edge. The
Owner explicitly clarified that portrait means height 4 and width 3. Portrait
and other mismatched images are center-cropped to fill this preview; this
supersedes round 4's uncropped preview requirement. The full original remains
available in Viewer. Preserve shared tab collapse, carousel gestures, image
identity and all earlier authorized behavior. No API, database, dependency or
Production changes. Validation selects Web incremental checks (300 seconds) and
cold browser smoke (300 seconds), with independent incremental diff review.

## Owner phone feedback round 6 (2026-09-20)

Keep the width 3, height 4 phone Detail display area. Both portrait and
landscape images must remain complete, without cropping, and scale to the
largest size that fits this area while preserving their proportions. Center the
image; any unused space shows the page background. Live Photo motion uses the
same contain framing as its still. This supersedes round 5's cover/cropping
requirement. Keep Viewer, carousel gestures, detail collapse, spacing and the
restored continuous tab animation unchanged. Only presentation CSS, the existing
focused regression assertions and this scope record change. Validation:
incremental Web checks (300 seconds) and focused cold browser smoke (300
seconds).

## Owner phone diagnostics round 7 (2026-09-20)

The Owner reports persistent physical-phone Home icon flicker and authorizes an
opt-in phone capture with synchronization to this local preview computer for
analysis. Add a development-only diagnostic UI and same-origin numeric ingestion
route. Capture bounded frame timings, pager/icon progress and identity, viewport
changes, gesture coordinates, user flicker marks and available long-task timing.
Exclude user content, accounts, headers, cookies, full URLs, console text and
error stacks. Logs remain in private temporary files, never Git; Production
renders no diagnostic UI and ingestion returns 404. Ordinary preview visits do
not record. Retain all current presentation and gestures. The local diagnostic
workflow is a data-collection handoff, not a claimed root cause or phone fix.
Validation selects incremental Web checks (300 seconds) and a focused cold
browser smoke (300 seconds), plus independent review.

## Owner phone diagnostics round 8 (2026-09-20)

Analyze the Owner's downloaded recording against local synchronized batches.
Retain raw evidence privately. The first synchronized recording exhausted the
201-batch limit after 18.3 seconds because the active flush loop kept sending
newly captured rows; its complete 30.4-second download recovers the remaining
rows. Bound active flushes to their initial queued snapshot, and drain all
remaining rows after recording stops, including a stop during an active request.
Keep immutable retries, numeric-only storage, server quotas and animation
behavior unchanged. Regression-check sustained capture under delayed responses,
request count, stop-during-upload and equality of downloaded/server events. This
repairs diagnostic transport only. Sampled DOM/CSS consistency cannot establish
successful physical-phone painting or close the flicker report. Validation:
incremental Web checks (300 seconds), focused browser smoke (300 seconds) and
independent incremental-diff review. No Production/Git delivery.

## Owner phone diagnostics round 9 (2026-09-20)

The Owner supplied a phone screen recording plus a complete synchronized
capture. The video shows the Home Calligraphy glyph absent and present in
adjacent frames while its label remains visible. Numeric progress/opacity/scale
remain continuous at the sampled points. This narrows investigation to glyph
rendering without establishing a specific browser-internal defect. Render only
the three animated Home category icons as direct inline SVG using the exact
existing paths, viewBoxes and strokes from shared UI assets. Keep the shared
AnimatedTopTabs and Discussion implementation unchanged, including continuous
scale, opacity, label movement and underline motion. Preserve Nearby viewport
correction and all prior behavior.

The diagnostic numeric renderer field now distinguishes direct SVG (2) from a
present CSS mask (1) or missing mask (0); ingestion shape remains unchanged.
Regression-check canonical artwork parity, theme inheritance, preserved gesture
motion and Home-only renderer selection. Scope: shared UI brand component, Home
composition, numeric diagnostic renderer identification, focused tests and this
record. No dependency, data, backend or Production changes. Use incremental Web
checks (300 seconds), focused browser smoke (300 seconds), and independent
review. A browser pass does not replace the Owner's follow-up physical-phone
acceptance.

## Owner acceptance and delivery round 10 (2026-09-20)

The Owner confirmed that the physical-phone behavior is now normal and
explicitly authorized task closure, hiding the temporary logging functionality,
and merging/synchronizing the completed work to the remote repository. This
supersedes the earlier local-preview-only delivery limits. The accepted Home
inline-SVG rendering and original continuous Discussion animation remain intact.

Remove the temporary development diagnostic component, layout mount and numeric
ingestion route. Old diagnostic query links render the ordinary application, and
the retired ingestion endpoint returns 404. Retain diagnostic evidence
privately; do not include user recordings or synchronized logs in delivery.

Review the complete cumulative diff against current main, run the applicable Web
complete, PostgreSQL and cold browser checks within the existing bounded
validation profiles, and use the configured task Git helpers and shared core
credential-check allowance. Merge only the reviewed head after required hosted
checks pass; verify squash tree equality and fresh merged-head CI. This grants
no Production deployment, historical content purge, cloud change or unrelated
worktree cleanup.

The Owner's final presentation adjustment assigns a newspaper icon to News
(近闻) and an academic cap to Topics (专题). Threads (话题) keeps its existing
discussion icon. These two shared UI assets and the Discussion icon mapping
change only; preserve the accepted pager-driven animation logic.

The final Home Calligraphy (书帖) icon uses a brush-tip silhouette instead of
the former book glyph, retaining the shared currentColor, 1.7-unit rounded
stroke, 24-unit viewport and direct SVG renderer. Update its canonical artwork
and animated copy together; keep all Home paging and animation logic intact.

## Traditional brush correction round 11 (2026-09-20)

After round 10 was merged, the Owner clarified that the Calligraphy glyph
resembles a fountain pen. Replace its angular handle and central nib-like line
with a rounded short bamboo handle, one bamboo joint and a curved, full bristle
body tapering into a flexible tip. Keep the canonical shared asset and direct
animated SVG identical, preserving their 24-unit viewport, 1.7-unit currentColor
stroke, rounded line joins and existing animation. Only the two artwork copies,
the existing artwork fingerprint assertion and this task record change. The
Owner's task-closure and remote-merge instruction continues to apply; use the
existing bounded checks and independent exact-head protected-delivery workflow.

The Owner additionally requested an ink-dipped tip: fill approximately half of
the bristle area nearest the tip with the inherited ink color, retaining the
upper bristle outline. The fill follows the original bristle boundary and is
rendered before its outline. Extend the existing canonical/animated artwork
parity regression to cover both layers; retain theme inheritance.
