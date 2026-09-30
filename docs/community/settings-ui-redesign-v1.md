# Settings UI redesign v1

Task: settings-ui-redesign-v1, Issue #170 r1. The Owner-approved implementation
stops at an independently reviewed Draft candidate and a Development preview.
Visual, interaction and physical-phone acceptance remain Owner gates. Issue
assignment stays unchanged.

## Behavior matrix

| Surface              | Development / Owner QA                                                                | Production                      | Preserved behavior                                                                  |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| Settings navigation  | Grouped root and child views; mobile full screen, desktop centered panel              | Existing exposure gates         | Source history, focus, scrolling and one modal owner                                |
| Appearance           | Explicit theme and feed-layout choices apply immediately                              | No new exposure                 | Existing storage keys and defaults; desktop hides layout choices; cycle APIs remain |
| List privacy         | Four choices and explicit Save; drafts survive child Back; root exit confirms discard | Existing API and authorization  | Failed saves retain input; only confirmed saves update saved state                  |
| Blocked accounts     | Lazy load, empty/error/retry, serial paging and confirmed unblock followed by read    | Existing relationship semantics | Unblocking does not restore following                                               |
| Account security     | Masked factors and verification child within the same modal                           | Real providers stay gated       | Identity, verification purposes, expected versions and idempotency payloads         |
| Sign-out / Edit Info | Sign-out waits for success; Edit Info waits for settings close                        | Existing gates                  | Unsaved draft confirmation happens before logout; editor stays unchanged            |
| Guest                | Appearance and a sign-in entry                                                        | Existing gates                  | No private account reads                                                            |

## Navigation and state ownership

AuthorDialog remains the sole history owner. Its optional guardChildBack
defaults to true for existing consumers; settings uses false so child Back
retains the root-owned privacy draft. Root Back and browser leave remain
guarded. Busy writes block all Back paths and duplicate submissions. A consumed
root entry releases popstate ownership before the exit animation, so another
browser Back belongs to the source page.

Only the active view is mounted. AccountSecurity stays mounted between the
security overview and verification child to preserve its protocol state, while
its inactive overview is removed. Back cancels a local verification flow when
idle. Synchronous busy gates cover proof verification and the following mutation
as one operation. Generation, unmount and expected-viewer checks discard late
responses, including leaving and later returning to the same account.

Successful sign-out consumes settings history and completes its closing
transition before navigation. Failed sign-out retains the current draft and
exposes an error. A missing or mismatched account cannot authorize a mutation
for an expected viewer.

## Motion and input

Settings uses the existing normal 200ms duration and standard easing, animating
transform and opacity only. Forward enters from the right; Back enters from the
left. Reduced motion switches views immediately. Root close never depends on an
animation event firing.

A settings-local right swipe calls the same Back handle as the header. The first
24px at the browser edge, interactive controls and focused text input are
excluded. Vertical intent wins; cancelled, short, resized, multi-touch and busy
gestures do not navigate. Pinch zoom remains available. Drag updates use
requestAnimationFrame and element styles without React updates on every move.

The header stays fixed above one content scroller. Child Back restores the prior
scroll and entry focus. Mobile safe areas and dynamic viewport height are
respected. The existing profile editor, login/registration UI, backend,
database, Contracts and design-token package are outside this change.

## Acceptance

Relevant unit coverage includes default and opt-in modal history, draft
retention, save failure, late account responses, paging, duplicate writes,
proof-to-unlink busy continuity, sign-out confirmation, expected-viewer
isolation, keyboard choices and gesture cancellation.

Browser acceptance uses disposable synthetic accounts and the real
Web-to-Backend path on ordinary HTTP, covering 320, 390, 430, 768 and 1280px.
Task-private evidence records the baseline and candidate fingerprints, sanitized
screenshots, recording and any injected failures. Browser viewport and touch
emulation are not physical-device acceptance. Physical-phone and Owner
visual/interaction acceptance are NOT TESTED until the Owner records a decision
for the reviewed candidate.

The cumulative verify-task entry, exact-head CI and independent review are
required for the Draft handoff. No animation performance improvement is claimed
without measured evidence.

## Owner visual refinement r2

The Owner requested graphical, concise settings with uniform mature-library
icons, while preserving older icons on every other interface and matching the
current ArtVenn UI. Only settings imports the locally vendored Lucide subset
with fixed upstream provenance and full license. No dependency or global icon
asset changes are introduced. AuthorDialog accepts an optional presentation-only
back icon; its default remains unchanged.

The root keeps short labels and meaningful current/draft status. Appearance uses
three theme preview cards and two layout diagrams with the existing radio
semantics, visible labels, keyboard selection and persistence. Privacy and
account rows use the same decorative SVG vocabulary; explanatory text retains
privacy, relationship and verification limits. Existing tokens determine colors,
spacing, type and rounding. All r1 state/protocol/motion and Draft gates remain
applicable.
