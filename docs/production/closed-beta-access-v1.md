# Closed-beta access

Issue #212 (`closed-beta-access-v1`). One server-enforced policy decides who may
reach product content. It does not create a second site, a second login or a
site password, and it changes no account, content, id or permission.

| Mode          | Who reaches product content and commands                                                            |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `closed-beta` | Only accounts listed in the allowlist file, signed in through the existing login.                   |
| `public`      | Everyone, exactly as before this policy existed. Every other rule (authentication, privacy) stands. |

Development defaults to `public`, so a stack that does not opt in is unchanged.
Production must name its mode: without one the Backend does not start.

## Where it is enforced

- **Backend, in front of the router.** Every route is protected unless it is on
  a short named list: readiness, the session owner's own identity (`/v1/me`),
  the access answer (`/v1/community/access`), and the operations that obtain or
  end a session (capabilities, challenges, password login and reset,
  registration, sign-out — each with its own existing rules, such as closed
  registration). Without a valid session a protected route answers
  `401 UNAUTHENTICATED`; with a valid session whose account is not listed it
  answers `403 ACCESS_RESTRICTED`. Both are JSON, never a login page.
- **Eligibility is asked on every protected request.** It is never written into
  a session, so an account that was removed is refused on its next request with
  the session it already has, on every device.
- **The Owner's operator boundary** (`/internal/community/*`, used by Admin)
  keeps answering only to its own credential. Admin needs no public-user
  session, and a tester's session is not Admin authority.
- **Article MCP** keeps its protocol: the discovery document stays reachable and
  a delegated grant is still the credential. A grant whose account is not listed
  is refused (`403` at admission, an error on a tool call); tool schemas are
  unchanged. New grants need the human consent routes, which follow the session
  policy.
- **Web** asks the Backend before it renders. Without access it sends a small
  notice and the existing login — the product page, its data and its RSC payload
  are not produced at all. Catalog, search and comment relays pass the visitor's
  session on, so the Backend decides; prototype documents under
  `/docs/prototypes` are served only with access. If the Backend cannot be
  asked, Web shows "temporarily unavailable" rather than the product.

No protected Production answer may be stored: the Backend answers `no-store`,
and session-dependent Web pages, relays and prototype documents are
`private, no-store`. Catalog JSON, search, comment and prototype responses also
set `Vary: Cookie`; Next pages and RSC responses retain the framework's `Vary`
headers. `no-store` is the cache barrier, independently of `Vary`. Next
Development pages instead use its `no-cache, must-revalidate` behavior; their
access checks still run for each request. Two kinds of relay answer are
revalidated instead of unstored, both `private, no-cache` with `Vary: Cookie`
and a strong `ETag`:

- A `200 image/png` for `/api/community/media/user-media-<id>`, the original
  profile image. Its `ETag` is the SHA-256 of its bytes, and such an id names
  one immutable upload.
- A `200` or `206 image/webp`, or its `304`, for
  `/api/community/media/user-media-<id>/<role>`, a rendition of a current avatar
  or cover: the owner's current avatar for an `avatar-*` role, the current cover
  for a `background-*` role. Its `ETag` is the SHA-256 of the rendition. A
  rendition URL is stable but does not name one immutable upload: its bytes
  change when the role's recipe version changes, and the `ETag` changes with
  them. The Backend decides the `304` itself, from the stored hash after it has
  authorized the read, without reading storage.

The viewer's browser may keep these bytes in its own cache. A normal load still
goes through the relay, the Backend authorizes the read exactly as before (for a
rendition, the original image's rule narrowed to the current avatar or cover),
and only an unchanged body is answered `304` without bytes. Owner-only rendition
reads (a replaced avatar, a cleared cover) carry no `ETag` and stay
`private, no-store`, as entry 5 of the
[unified media pipeline amendment](../governance/amendments/2026-10-04-unified-media-pipeline.md)
requires; so do errors and every other answer. Browsers may still reuse a cached
image without asking on back/forward or session-restore loads while the session
cookie is unchanged (`Vary: Cookie` forces revalidation after a cookie change),
and the bytes stay in the device's browser cache after sign-out until they are
evicted or refused on a later load (Owner decisions, 2026-10-13,
profile-media-startup-relief-v1 and, for renditions, profile-media-renditions-v1
D4). Nginx has no cache. The unused Next.js image optimizer is closed for every
source, so its cookie-blind shared cache cannot retain a protected image across
a mode or eligibility change.

In both modes the root page and the prototype documents are rendered only after
the Backend has answered; without a reachable Backend, Web serves neither.

## Configuration

Private Backend environment (`/etc/yoyi/backend.env`):

```sh
PRODUCT_ACCESS_MODE=closed-beta
PRODUCT_ACCESS_ALLOWLIST_FILE=/etc/yoyi/product-access.json
```

The allowlist names accounts by their immutable public user id — the `userId`
the provisioning command prints, never a handle, a display name or an e-mail:

```json
{
  "version": 1,
  "accounts": [
    { "id": "user-0123456789abcdef0123456789abcdef", "label": "note" }
  ]
}
```

- `label` is an optional operator note (up to 80 characters). It decides nothing
  and is never logged.
- Install the file owned by the Backend service user, mode `0600`. The loader
  checks that it is a regular file (not a symlink), has no group/other
  permission bits, and contains at most 64 KiB and 500 accounts, with no other
  fields and no duplicate ids. That user must also be able to reach it: every
  directory on its path needs search permission for the service user. Running
  the validation command below as that user proves both.
- An empty `accounts` list is valid and admits nobody.
- Real ids belong only in this private file. Do not put them in the repository,
  an Issue, a pull request or a log; the Backend logs counts only.

Validate before anything is activated. The command prints the mode and a count,
never the ids:

```sh
# the configuration the Backend would start with
sudo -u yoyi-backend env NODE_ENV=production PRODUCT_ACCESS_MODE=closed-beta \
  PRODUCT_ACCESS_ALLOWLIST_FILE=/etc/yoyi/product-access.json \
  node services/backend-production/dist/access/check.js
# a candidate file, and whether one account is admitted by it
sudo -u yoyi-backend node services/backend-production/dist/access/check.js \
  --file /etc/yoyi/product-access.json.next --has user-<32 hex>
```

A refusal prints `PRODUCT_ACCESS_REFUSED` with the reason and exits non-zero.

## Adding or removing a tester

1. Write the complete new list to a sibling file with the same owner and mode,
   for example `/etc/yoyi/product-access.json.next`.
2. Validate it with `--file`. When removing someone, confirm with `--has` that
   the Owner's own account is still admitted.
3. Move it into place:
   `mv /etc/yoyi/product-access.json.next /etc/yoyi/product-access.json`. A
   rename replaces the file in one step, so the Backend never reads half of it.

No restart or reload is needed. The Backend looks at the file again when it next
decides a request, at most once per second, so a replacement applies to the
first protected request that arrives about a second or more after it; it then
logs `product access allowlist reloaded (N accounts)`. The interval is measured
on a monotonic clock, so a wall-clock adjustment cannot delay it.

What a removal does, and when:

- **Requests:** the removed account's next protected request is refused, with
  the session it already holds. The session itself stays valid, so the account
  can still sign out and sees the restricted notice.
- **Open pages:** the page asks again when it regains focus or a request is
  refused, then reloads into the restricted notice.
- **Notification streams:** an open stream ends at its next identity check, at
  most 15 seconds later, and cannot be reopened.
- **Signed media links:** Catalog images are delivered through short-lived
  signed links (`COS_SIGNED_URL_TTL_SECONDS`, 300 seconds in the template, never
  above 600). A link issued before the removal keeps working until it expires;
  nothing can recall it or anything already downloaded.

If the file is missing, unreadable, too open or malformed, the Backend denies
every account and logs that once; it never keeps serving an older list. Fix the
file and move it into place again.

## Opening the product later

Not part of Issue #212. When the Owner decides to open:

1. Set `PRODUCT_ACCESS_MODE=public` in the private Backend environment.
2. Restart the Backend. The mode is read at startup, so this one step is
   deliberate and visible.

Nothing else changes: no release, no migration, no Web or Nginx change. The
allowlist file may stay where it is; it is ignored in `public` mode. To return
to a closed beta, set the mode back and restart; protected answers were never
cacheable, so no earlier public answer can be replayed.

## Rollback that keeps access restricted

A rollback must never reopen the ungated site. In order of preference:

1. **Roll back to a release that still contains this policy** and keep the same
   environment and allowlist.
2. **Deny everyone:** install an allowlist with an empty `accounts` list (no
   restart), or stop the Web and Backend services. Product content is then
   unavailable to all visitors until a gated release is active again.

Do not activate a release from before this policy on the public hostname, and do
not "recover" by setting `public`. In particular, never run a Backend from
before this policy behind the public hostname, even with a current Web: the
pages would show only the unavailable notice, because that Backend cannot answer
the access question, but the Web relays would still pass on whatever an ungated
Backend serves.

## Media

While closed beta is active, media stays behind the policy only on the delivery
paths that exist today: same-origin relays (decided per request by the Backend)
and short-lived signed links handed out inside protected answers. A stable
unsigned public media URL would bypass the policy. Any change of media delivery
therefore needs an arrangement that keeps this restriction, verified before it
is switched on (coordinated with Issue #206). Profile image renditions
(increment 3a, Issue #270) use only the same-origin relay and are never
published to the edge.
