# Authentication interface redesign

Task `auth-ui-redesign-v1`, Issue #167. Implementation was explicitly authorized
after the Owner approved the standalone-page plan. Start point: main `c0742e9`.

## Scope and delivery

One shared AuthFlow serves /login and /register. Mobile uses a full page;
desktop a narrow centered form. Email stays primary. Six-digit verification
requires explicit submission. Reuse the existing semantic tokens and controls.
Allowed changes are auth presentation/hosts/client, root transient auth return
context, narrow source navigation/composer/checkpoint adapters, directly
affected tests and this specification. The original r1/r2 scope excluded
backend, database, public protocol, binding UI, providers or Production exposure
changes in the original scope. The explicit r3 delta below replaces the
password/database/protocol exclusions only for the narrowly named capabilities.
No dependency version upgrades. Stop at a reviewed Draft candidate and an
API-connected preview, pending recorded visual/device acceptance.

## Owner visual revision

The Owner rejected the first candidate's squared control outlines and supplied
an updated ArtVenn mark. Authentication now uses the current product's capsule
primary controls and selected category-pill treatment: no outer channel frame,
no ordinary hard input outline, preserved focus/error affordances, and a rounded
primary action. Existing auth/API/return behavior is unchanged.

The explicit replacement request extends this task to the canonical shared brand
asset, its aspect ratio, browser icon metadata, Admin graphics and directly
related provenance/asset checks. Admin adds the existing `@moya/ui` workspace
dependency to consume its exported asset; no external package version changes.
CI routing includes UI and its design-token dependency in Admin coverage. The
Admin icon redirect keeps a relative Location so the public ingress origin
remains authoritative. All current consumers use the new transparent mark.
Historical screenshots/records remain evidence of their original candidate.

## Owner revision r3: passwords and concise onboarding

The Owner's actual iPhone screenshot and explicit requirements on 2026-09-30
replace the original no-password/no-recovery/no-migration exclusions for these
capabilities only. Extend the existing public CommunityAuth and public-user
profile; do not reuse CMS accounts or create another identity/session system.
Root retains the sole worktree writer. Separate authors prepare private patches;
a separate reviewer inspects the applied source. Original README work is kept.

The visible product name is **由于艺**. Every current canonical-logo consumer
uses the product accent via a centralized system-orange semantic token.
Authentication removes the progress strip, repeated verification explanations
and Development footer. Each page has one primary action, capsule inputs, 16px
input text and 44px or larger targets. Registration follows account → code →
password → profile → optional avatar. Profile collects the required nickname and
independent optional studio name (斋号), at most six Unicode code points.
Existing names are preserved.

Password login and code login are alternative methods for the same immutable
user. New registration UI requires a password and a matching confirmation.
Password policy is exactly 6–20 Unicode code points, at least one ASCII
uppercase letter and one digit; no additional lowercase, symbol or ASCII-only
requirement. Do not trim passwords. Confirmation is compared locally; the server
receives one password and validates the same policy. Passwords and confirmations
remain in flow memory and are never included in return snapshots or browser
persistence.

Use Node's asynchronous scrypt with the OWASP-listed N=2^15, r=8, p=3
parameters, 16-byte or longer independent random salt, a versioned verifier,
bounded concurrency and constant-time comparison. This is a mature storage
mechanism; the Owner's six-character minimum is below NIST's current
single-factor password length guidance and is not described as NIST-compliant.
No dependency upgrade or experimental crypto API is required.

Allowed additional paths are the auth DTOs/exports/JSON-schema registry in
`packages/contracts/src/`; existing CommunityAuth service, auth persistence
ports, crypto helper and directly related tests in `services/api/`; auth/profile
PostgreSQL adapters and migration manifest in `services/community-postgres/`;
Development auth handler in `services/backend-runtime/`; auth OpenAPI schemas in
`services/public-api/`; one forward-only Community migration and its narrowly
needed role grants; existing profile editor/display; shared brand/token
consumers; and directly related browser, contract and PostgreSQL tests.
Production auth mounting, delivery providers, dependencies and unrelated
application domains stay unchanged. Existing optional-password accounts keep
code login; no default passwords or credentials are backfilled.

| Action                 | Existing boundary plus narrow extension                                | Result and recovery                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password login         | POST auth/passwords/login                                              | Existing HttpOnly Session grant; generic invalid-credentials error; manual retry retains its payload-bound operation key                           |
| Registration           | POST auth/registrations adds password and optional studioName          | Explicit profile/consent submission creates one user; altered payload cannot replay an old receipt                                                 |
| Forgot password        | Existing challenges with password_reset purpose, then verify           | Purpose-bound password_reset_required handoff, never a login/registration proof                                                                    |
| Save new password      | POST auth/passwords/reset                                              | Consume proof, replace credential version, revoke all sessions, close all user receipts and invalidate old proofs atomically; no automatic sign-in |
| Avatar                 | Existing me/profile and avatar upload/save after identity confirmation | Explicit photo save only; skip keeps the existing default initials; failure does not undo account creation                                         |
| Edit studio name later | Existing me/profile command                                            | Omission preserves the value; explicit empty string clears it                                                                                      |

| Scenario                                     | Development behavior                                                                               | Preserve                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Existing email/phone code account            | Code login works; verified reset can establish its first password                                  | Same user and contact provenance; no default backfill            |
| Unknown/incorrect/suspended password account | Generic error and equivalent slow-verification path; target/source/global throttles before hashing | No account-existence disclosure or expensive unbounded hashing   |
| Reset versus in-flight login                 | Lock and recheck credential version/identity before Session mint                                   | Old password cannot sign in after a concurrent reset             |
| Reset replay or another-purpose proof        | Purpose-bound, one-use, expiring proof; payload-bound manual retry                                 | No Session resurrection or arbitrary credential mutation         |
| Registration avatar skip/offline             | Account remains created; photo requires explicit upload/save                                       | No anonymous upload or automatic content writes                  |
| Page/back/method changes                     | Ordinary identifier survives; old proofs, codes and passwords are invalidated                      | Safe source return and per-account draft/private-state isolation |

This is a new substantive requirements slice, not a retry of the previous visual
or main-integration acceptance runs. Their failures, corrections and remaining
return-scroll finding are retained in the private task record. Prepare and
independently review the new candidate before cumulative acceptance; record
corrections against this actual source scope. Physical iPhone acceptance of the
new password/reset/avatar flow remains pending until device actions are
recorded. Delivery remains a reviewed **Draft** with a usable Development
preview, without Ready, merge, Issue closure or Production activation.

## Latest-main integration

The task integrates the grouped settings navigation from #172. Authentication
return restores only the public settings page and scroll positions. The factor
page falls back to account security because verification proofs do not survive
navigation. Existing account resets, private-state reloads, Back/swipe and dirty
form guards remain authoritative; no settings mutation is restored or submitted.
If delayed content initially clamps a saved scroll position, the returned view
retries as its content grows. Pointer, touch, wheel or scrolling-key interaction
ends that pending restoration so later data cannot move the user's position.

## Action mapping

| Action         | Existing operation                                       | Pending/result/recovery                                                                                                |
| -------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Load channels  | GET /api/community/auth/capabilities                     | Independent loading, unavailable and retry states                                                                      |
| Send/resend    | POST /api/community/auth/challenges; sign_in or register | Disable duplicate submission; require usable continuation; use server resendAvailableAt                                |
| Verify         | POST /api/community/auth/challenges/verify               | signed_in returns; registration_required requires explicit creation; already_registered offers fresh sign-in           |
| Create         | POST /api/community/auth/registrations                   | Nickname and agreement required; registered result returns; uncertain result keeps original operation for manual retry |
| Identity check | GET /api/community/me                                    | Existing refused-cookie recovery; transport failure never means logout                                                 |

No automatic command retries. A retry of unchanged payload retains the operation
UUID; changed payload/new resend starts a new operation. A lost challenge or
registration handoff cannot be reconstructed from an idempotent response without
its proof. Proofs/codes stay in component memory. Neither abort nor route exit
undoes a server transaction or Set-Cookie. No stale callback navigates the user.

## Behavior matrix

| Scenario                           | Development                                                               | Production          | Preserve                                                       |
| ---------------------------------- | ------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------- |
| Email/phone login and registration | Real Web relay/backend/isolated PostgreSQL; local capture/simulated SMS   | Existing gates      | One identity, explicit creation, server purpose/limits         |
| Switching/edit/back                | Keep ordinary input, invalidate obsolete proofs                           | No new exposure     | Source navigation and account isolation                        |
| Network/code/provider errors       | Recoverable, truthful states; no invented unlock/countdown                | No live sends       | Server timing, replay and receipt safeguards                   |
| Return                             | Restore source UI and same-account draft only after identity confirmation | Existing behavior   | No automatic posting/following/upload or private-data transfer |
| Refresh/logout/account change      | Restart verification; clear old-account private state                     | Existing safeguards | HttpOnly session, guest favorites and publishing recovery      |

The root context is memory-only and belongs to the mounted browser root. Sources
own their view snapshots. No entire Next history envelope, auth material, DM
body or session token is retained there. Public filters/pages are reloaded
through existing APIs. Existing editor recovery owns its checkpoints; navigation
performs no remote save and uploads do not automatically resume.

## Verification

Cover both purposes/channels, unavailable channels, paste, races, every
actionable code error, manual retries, cancellation, agreements and account
transitions. Dedicated Development browser journeys must use real auth API and
disposable PostgreSQL with local delivery capture. Run applicable
lint/typecheck/tests/build, cumulative task validation and exact-candidate CI,
then independent diff review. Inspect desktop, 320/390px, dark mode, large text
and keyboard states. Physical iPhone Safari acceptance is a separate recorded
result; emulation is not a pass. Keep all runtime credentials, OTPs and private
evidence outside Git/public text.

## Development browser acceptance

`tests/e2e/auth-ui.playwright.config.ts` is an opt-in acceptance entry, separate
from the ordinary cold browser smoke. Provision a task-owned backend using the
existing migrations and role grants, an isolated PostgreSQL database, local
Mailpit capture, and a synthetic published Catalog through existing Payload
hooks. Keep runtime files and capture output private; never use persistent Owner
QA data. Point the Development Web's existing same-origin relay to that backend.
Use a new isolated database or allow the real server's source window to expire
between complete runs; do not relax throttling.

Run once for each backend profile (`email-first`, `full-local`):

```sh
AUTH_UI_PROFILE=email-first \
AUTH_UI_CATALOG_ID=catalog-auth-ui-167-synthetic \
AUTH_UI_BASE_URL=http://127.0.0.1:3550 \
AUTH_UI_MAILPIT_URL=http://127.0.0.1:3553 \
AUTH_UI_ARTIFACT_DIR=.local/auth-ui-e2e/email-first \
  mise exec -- pnpm --filter @moya/tests exec playwright test \
  --config e2e/auth-ui.playwright.config.ts
```

The entry rejects non-loopback targets, runs one worker without retries, and has
a shared 299-second deadline. It exercises Chromium and 390/320px WebKit. It
covers explicit registration, same-account login, existing-account handoff,
unknown-account creation confirmation, full-code input, agreement return, wrong
code, real resend, purpose/channel reset, cancellation and native Back. A
captured SMS probe runs once in `full-local`; additional mobile copies are
intentionally skipped to keep the source send count below the existing limit.
The synthetic detail probe uses the actual app login link, preserves its
comments tab and same-account draft, and asserts no automatic comment. The
visitor profile tab probe asserts soft navigation preserves the document.

Codes, capture bodies, continuation/handoff proofs and cookies are used only in
memory. Traces/videos are disabled. Screenshots explicitly require an empty
verification field and disable transition capture. Never publish Playwright
failure context without reviewing its exact content.

Unit regressions additionally cover unsupported/failed capabilities, stale
responses/finally, manual idempotent retries, invalid/expired/superseded proofs,
exhaustion and limits, malformed successful replies, actor isolation, delayed
identity remounts, reply targets on a later source page, asynchronous reader
scroll restoration, and unavailable Catalog/Work/topic source recovery.

## Visual and physical-device record

Browser inspection must include desktop, 320/390px, light/dark, 200% text and
empty-code screens. Navigation wraps when larger text needs a second line.
Confirm target size, focus, horizontal overflow and ordinary page scrolling.
Browser WebKit is not physical Safari evidence.

Physical iPhone Safari remains a separate acceptance gate for the same
candidate: record device/OS, route, performed steps, observed outcome and
evidence. Cover application switching to retrieve a local captured code,
whole-code paste, numeric keyboard, native Back/cancel, safe areas, rotation and
weak/offline network recovery. Local capture does not prove native Messages/Mail
one-time-code autofill; that requires an explicitly authorized live
delivery/device setup. Leave any unperformed item pending. No automatic posting,
following or publishing is permitted during acceptance.

## Owner revision r4: achromatic deboss branding

The Owner explicitly replaced the orange-logo direction with achromatic recessed
graphics across current Web, Admin, loading, navigation and favicon consumers.
The visible `由于艺` wordmark uses black ink with a shallow recessed edge.
Shared neutral colors live in design tokens; Admin adapts only the mark
variables to its own theme. A small neutral light text surface keeps the
requested black wordmark legible in dark mode. Forced-color presentation uses
system foreground/background for readability.

Retain both approved canonical paths, their aspect ratio and transparent lens;
use only inner silhouette edges, with no outside logo shadow or enclosing tile.
Keep authentication behavior and control accents unchanged. This visual revision
does not grant another correction round for the separately pending r3
domain-policy or settings proposals. Record focused checks and actual
screenshots separately from the existing failed/incomplete cumulative gates and
physical iPhone acceptance.

## Owner acceptance and final delivery

The Owner reported acceptance passed and explicitly requested final closure,
merge and Issue167 completion. This supersedes the Draft-only delivery stop.
Final corrections preserve accepted UI/auth behavior: legal domain
password/studio validation with transport-policy parity regressions; missing
central request-type exports; and a one-shot settings scroll restore that
preserves later local scroll choices and StrictMode replay. Independently review
the final exact candidate, pass native cumulative validation and CI, then squash
merge that pinned SHA and verify the merged main tree/CI before administrative
closure. No Production change is authorized. Owner acceptance is an
Owner-reported judgment; browser screenshots are not labelled as separately
observed physical-device evidence.

Final independent review also required correctness repairs: re-read the
challenge target identity after known User locks and reject ownership/provenance
drift before any Challenge write; retain an already-confirmed owner's selected
avatar/crop during focus revalidation, with saves blocked until identity is
confirmed again and selection cleared on account switch, refusal or profile
ownership failure. These repairs do not change the accepted visual direction.

Preserve controlled authentication-return tickets for the existing same-URL
local avatar dialog, requiring matching journey tickets and history-entry
identity; unrelated pushes still retire the journey. Explicit settings close or
edit departure consumes only its child/parent restoration snapshots so an
ordinary reopen starts at the root. Checking/account rekeys and StrictMode
cleanup retain pending restoration; unrelated source views and drafts survive.
