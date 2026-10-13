# Web browser support

Task `web-browser-baseline-v1` (Issue #262). This page states which browsers the
Web app supports, what evidence backs each claim, and what is still unverified.

## Supported floors

| Engine                                        | Floor | Notes                                                        |
| --------------------------------------------- | ----- | ------------------------------------------------------------ |
| Safari, including iOS and iPadOS              | 16.4  | Every iOS browser uses WebKit, so the iOS version decides.   |
| Chrome, Edge and other Chromium-based engines | 111   | Includes WebViews such as HarmonyOS 5 ArkWeb (Chromium 114). |
| Firefox                                       | 121   | The shipped CSS uses `:has()`, which Firefox has from 121.   |

Below these floors (Safari below 16.4, Chromium below 111, Firefox below 121, IE
mode) the app is unsupported and nothing is adapted for them. The core flows
covered by the floors are entering the site, navigation, browsing, search,
detail pages, login and session handling, and ordinary image and text
publishing.

The Firefox floor is a support statement, not a compile target. The compile
target stays at Next's defaults, pinned in `apps/web/package.json`
(`browserslist`: chrome 111, edge 111, firefox 111, safari 16.4) so that a Next
upgrade cannot raise it silently.

## How the code keeps to the floors

- `AbortSignal.any` (Chrome 116, Firefox 124, Safari 17.4) is never called by
  first-party code. Requests link their signals with `linkAbortSignals` from
  `apps/web/lib/platform/abort-signals.ts` and `dispose()` the link once the
  answer is read, so a long-lived signal (the per-document read signal) keeps no
  listener per finished request. ESLint refuses `AbortSignal.any` in `apps/web`
  and `packages`, workers included.
- `@uppy/xhr-upload` calls `AbortSignal.any` itself. `instrumentation-client.ts`
  runs `installAbortSignalAny()` before hydration; it installs an
  `AbortSignal.any` with the standard shape (an enumerable `any`, a TypeError
  for anything but an iterable of signals) only where the engine lacks one. It
  links through listeners, so it differs from the native algorithm in ways no
  current caller relies on: the result aborts while the source's own listeners
  run rather than after them, a listener that aborts another listed source first
  decides the reason, and signals from another realm (an iframe) are refused. It
  does not run in workers, which is why the lint rule covers them.
- `float: inline-start` (Chrome 118) on wrapped Article images has a
  `float: left` fallback for Chromium 111-117.
- `scripts/check-browser-baseline.mjs` runs after every Web build in
  `scripts/verify.mjs` (`all` and `build`, so also in CI's build job), right
  after its own tests (`check-browser-baseline.spec.mjs`, which need the
  workspace's parser and therefore run there rather than with the
  dependency-free `scripts/*.test.mjs`). It parses every client script as ES2022
  and fails on unguarded uses of a short list of post-baseline APIs:
  `AbortSignal.any`, `Promise.withResolvers`, `Promise.try`, `Object.groupBy`,
  `Map.groupBy`, `Array.fromAsync`, the new `Set` methods, `Iterator.from`,
  `RegExp.escape`, the `Uint8Array` base64/hex helpers, `URL.parse`,
  `Response.json`, `ReadableStream.from`, `checkVisibility`,
  `requestIdleCallback` and `scheduler.postTask`.
  - A use counts as guarded only when a test of the same API (same object or
    receiver) proves it present: the branch of an `if`, `?:`, `&&` or `||`, an
    earlier early exit, or an optional call. The test itself must not throw on a
    floor engine, so a bare `requestIdleCallback` or `Iterator.from` in a
    condition is a finding; `typeof requestIdleCallback` or
    `globalThis.Iterator?.from` is not.
  - `AbortSignal.any` may appear only inside Uppy's XHR upload module and as the
    installer's own feature test, and only while the installer ships in a root
    main file.
  - It is a tripwire for known gaps, not a compatibility proof. `union`,
    `intersection` and `difference` count only on a `new Set(...)`, because zod
    uses the same method names, and inline scripts in server-rendered HTML (the
    product boot script) are not scanned.

**Removal condition.** Delete `installAbortSignalAny` and
`apps/web/instrumentation-client.ts` once the floors reach Chrome 116, Firefox
124 and Safari 17.4. `linkAbortSignals` may stay; it is plain code.

## Evidence standard

A claim that an engine is supported needs all three:

1. a real engine build, not a modern engine with a changed User-Agent, a device
   preset or deleted APIs;
2. the production build (`next build` and
   `apps/web/scripts/start-production.mts`), not `next dev`;
3. the engine version string recorded with the result.

Playwright's "WebKit 16.4" is a Linux build of a WebKit trunk snapshot. It
approximates Safari 16.4; it is not iOS Safari. Only a real device or an iOS
Simulator runtime proves an iOS version.

## What is verified and how

Measured results and estimates are kept apart. Only "Measured" rows are
evidence.

### Measured (2026-10-12)

Old-engine lane (`tests/legacy-browsers`, production build, e2e Public API
fixture; run locally on Docker Desktop for Mac, arm64 images):

| Image                                        | Engine and version string                                              | Branch result            | Base build (05d40467) |
| -------------------------------------------- | ---------------------------------------------------------------------- | ------------------------ | --------------------- |
| `mcr.microsoft.com/playwright:v1.31.2-jammy` | Chromium `111.0.5563.19` (HeadlessChrome/111.0.5563.19, Linux aarch64) | PASS, 8 of 8 passed      | FAIL, 4 of 8 passed   |
| `mcr.microsoft.com/playwright:v1.31.2-jammy` | WebKit `16.4` (Version/16.4 Safari/605.1.15)                           | PASS, 8 of 8 passed      | FAIL, 4 of 8 passed   |
| `mcr.microsoft.com/playwright:v1.32.3-jammy` | Firefox `111.0` (rv:109.0 Gecko/20100101 Firefox/111.0)                | 7 of 8 (below the floor) | not run               |

- On the base build both floor engines failed the same four flows: no
  `/api/community/discover` request was sent, so no feed card could open a
  detail, and `/login` and `/register` never rendered their form. With the
  change all eight flows pass with no uncaught page error.
- Firefox 111 is below the floor and shows the expected gap: a feed card's open
  control is reported hidden, so a detail cannot be opened from the feed (the
  deep link works). Not investigated or fixed; Firefox 121-123 was not run.

Unit and build checks:

- With `AbortSignal.any` stubbed to throw, the author, publishing and Article
  authoring clients and the Article upload lease still send their requests,
  honor caller abort, the 15-second timeout, document retirement and the A -> B
  -> A account fence, and release the caller's signal after success and after
  failure (16 cases; all 16 fail against the previous code). With the native API
  removed and the installer run, the Uppy transfer uploads, cancels and uploads
  again. The helper itself has 13 cases, including zero listeners left on a
  long-lived signal after 50 finished links; a no-op `dispose()` fails six of
  them.
- `scripts/check-browser-baseline.mjs` passes on this branch (48 client scripts
  parsed as ES2022, the `noModule` polyfill chunk skipped, about 0.4 s) and on
  the base build reports exactly the six first-party `AbortSignal.any` sites and
  the missing installer. Its 12 spec cases include guards on the wrong object,
  in the wrong branch, after the use or that throw themselves.
- The `browserslist` pin alone leaves a clean production build byte-identical
  (all 101 files under `.next/static`); a deliberately different target changes
  47 of them, so Next reads the key.
- The built CSS keeps `float:left;float:inline-start` for wrapped Article
  images.
- Client bundle, base to branch: all client JS and CSS +1,268 bytes raw
  (5,158,504 to 5,159,772; +604 gzip), 14 chunks re-hashed; home route initial
  JS +1,062 bytes raw (+491 gzip).

- `pnpm verify` (120-second budget) with warm Turbo caches: base 49.7 s and 47.0
  s, this branch 47.5 s and 47.5 s, all PASS; the scan adds about 0.3 s. Web
  unit tests went from 3,430 to 3,457 (27 new); every earlier test is unchanged
  and passes.

### Estimated or not yet verified

- **Real Safari and iOS 16.4-17.3.** No real device or iOS 16.4 Simulator run is
  part of this task. The WebKit 16.4 lane is an approximation.
- **Authenticated flows on old engines.** The engine lane runs anonymous flows
  only. Login, the account fence, publishing and upload cancellation on old
  engines are covered by unit tests with `AbortSignal.any` removed, not by a
  real engine.
- **Media codecs.** See the capability matrix below; nothing there was measured
  on old engines.
- **WeChat, QQ, vendor browsers and HarmonyOS devices.** Not tested.
- **The 90% audience objective.** There is no first-party data on visitors'
  engines, so no coverage percentage can be stated. An audience census is a
  follow-up.

## Media capability matrix (expected outcomes)

These are the outcomes the existing feature probes should produce where a
capability is missing. They are expectations to check on real devices, not
results.

| Capability            | Needs                                                                                                    | Expected outcome where it is missing                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standard stills       | `OffscreenCanvas` in the worker (Safari 16.4, Chrome 69, Firefox 105)                                    | Present at every floor. Without it Standard processing reports unsupported and the author keeps the Original or removes the item.                                                                                                                   |
| WebP encoding         | canvas WebP encoding, which WebKit lacks                                                                 | Already probed (`preprocess/capabilities.ts`); WebKit writes PNG or JPEG instead.                                                                                                                                                                   |
| HEIC/HEIF decoding    | WebKit from Safari 17 (iOS 17, macOS 14); no other engine                                                | Safari 16.4-16.x (the reported iOS 16.6.1 iPhone included) and every non-WebKit engine: decoding fails (`decode_unsupported`) and the item gets the existing "keep the Original or remove" choice.                                                  |
| Live Photo motion     | WebCodecs: video from Safari 16.4 and Firefox 130; `AudioDecoder` and `AudioEncoder` only from Safari 26 | Firefox 121-129: motion is unsupported (`webcodecs_unavailable`). Safari 16.4-25: motion whose audio must be re-encoded is unsupported (`audio_decode_unsupported`, since the decoder is checked first); audio is never dropped. The still is kept. |
| Local upload recovery | IndexedDB and `navigator.storage.estimate` (Safari 17)                                                   | Safari 16.4-16.x: no recovery store; uploads work but do not survive a reload.                                                                                                                                                                      |

## Manual real-device checklist (Owner, after a separate deployment)

Real-device acceptance can only happen once the Owner deploys this change. It is
a post-merge follow-up, not a merge gate.

Devices:

- the reported iPhone on iOS 16.6.1 (a HEIC photo should offer the
  Original-or-remove choice there);
- an iOS 16.4 Simulator (Xcode 26.x or 16.x; Xcode 27 simulators start at iOS
  17);
- WeChat on Android;
- WeChat on iOS below 17.4;
- a HarmonyOS 5 device (ArkWeb is Chromium 114);
- one Android vendor browser.

Flows on each:

1. enter the site; the home feeds load;
2. search; open a detail and the viewer;
3. log in;
4. switch account while a request is pending (A -> B -> A), then sign out;
5. publish an image post and a text post;
6. cancel an upload mid-transfer and retry it;
7. leave and return in the middle of a request;
8. let a request time out and check that product copy is shown.

## Follow-ups not done in this task

- An "unsupported browser" notice for engines below the floors.
- Raw error text can reach the screen through `error.message` (for example
  "AbortSignal.any is not a function" in a feed); it should map to product copy.
- Timeout classification on Chromium 123 and older, where `fetch` rejects with a
  generic `AbortError` whatever the abort reason.
- An audience census of real visitors' engines.
- The Article editor's own resize preview
  (`features/editorial-content/article-authoring/article-image-resize.tsx`) also
  uses `float: inline-start` in an inline rule; it was outside this task's scope
  and still does not float on Chromium 111-117.
