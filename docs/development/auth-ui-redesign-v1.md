# Authentication interface redesign

Task `auth-ui-redesign-v1`, Issue #167. Implementation was explicitly authorized
after the Owner approved the standalone-page plan. Start point: main `c0742e9`.

## Scope and delivery

One shared AuthFlow serves /login and /register. Mobile uses a full page;
desktop a narrow centered form. Email stays primary. Six-digit verification
requires explicit submission. Reuse the existing semantic tokens and controls.
Allowed changes are auth presentation/hosts/client, root transient auth return
context, narrow source navigation/composer/checkpoint adapters, directly
affected tests and this specification. No backend, database, public protocol,
binding UI, providers or Production exposure changes. No dependency version
upgrades. Stop at a reviewed Draft candidate and an API-connected preview,
pending recorded visual/device acceptance.

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
CI routing includes UI and its design-token dependency in Admin coverage. All
current consumers use the new transparent mark. Historical screenshots/records
remain evidence of their original candidate.

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
