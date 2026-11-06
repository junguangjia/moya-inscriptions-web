# Standing release tool (phase A)

One release tool for every release, instead of a new toolkit each time. Python
standard library only. It never runs in CI against a real host: its tests build
a fake host from a profile.

- `release.py` runs on the operator's machine.
- `release_host.py` runs as root on the host. It is installed once per version,
  next to the host part of the profile, and pinned by sha256. A release payload
  never carries it, so changing the tool does not mean uploading a release
  again.

## The profile is private

Host names, directories, units, ports, env file paths and key names, time-zone
behaviour, the remote command and the live roots all live in a private profile
JSON. It is never committed, because this repository is public. Pass it with
`--profile` or `ARTVENN_RELEASE_PROFILE`. `tests/fixtures/profile.example.json`
shows the shape with fictional values. The host alias is read at run time from
the file the profile names; it is not copied into the profile.

Both sides refuse a profile they would misread: every service must appear in
`restartOrder` exactly once, have a `live` entry, known env files and code
paths, and the checks `verify` reads must be there.

## Verbs

| Verb                                                                | What it does                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install`                                                           | Installs the host tool and host profile (idempotent).                                                                                                                                                                                                                                                                             |
| `baseline`, `status`                                                | Read-only host facts. They also name services the ledger lacks (`notAdopted`) and roots moved outside the tool (`rootMoved`), with the step that fixes them.                                                                                                                                                                      |
| `plan <commit> --services a,b [--env FILES:KEY] [--unit-applied S]` | Local git checks plus read-only host facts. Decides per service: new root (its code changed) or restart only. The code paths in the profile are roots; the plan adds the workspace packages they depend on (from `package.json` at both commits) and the root build files. Refuses pending migrations and changed unit templates. |
| `build`                                                             | Local: the profile's builder, a delta against the live manifests, a payload in parts named by their sha256.                                                                                                                                                                                                                       |
| `stage`                                                             | Sends the plan and the missing parts; assembles the payload on the host.                                                                                                                                                                                                                                                          |
| `adopt [--rebaseline]`                                              | Records the live state as the ledger's next entry, adding services and env files the profile gained. `--rebaseline` also records roots a release outside this tool moved.                                                                                                                                                         |
| `prepare`                                                           | New roots, static unions, caches, rendered pins. No service change.                                                                                                                                                                                                                                                               |
| `env set FILES KEY --value-file F \| --generate token64`            | One key in the named env files and their staged copies. The value never travels on an argv and is never printed.                                                                                                                                                                                                                  |
| `switch a,b --plan ID --outage-ok`                                  | Pins, then restarts in the given order. Undoes itself on any failure or SIGTERM. Without `--plan` it is a restart on the same roots, answered `RESTARTED`, and refused (`PLAN_PENDING`) while a staged plan would move one of the services.                                                                                       |
| `verify`                                                            | Read-only checks.                                                                                                                                                                                                                                                                                                                 |
| `rollback --to previous --outage-ok`                                | Back to the state before the latest release.                                                                                                                                                                                                                                                                                      |
| `close-out --accepted`                                              | After a PASS verify: removes earlier env versions and old payloads; lists old roots that nothing uses.                                                                                                                                                                                                                            |
| `migrate`, `dns`, `cert`, `edgeone`, `nginx`, `unit`                | Not in phase A. Refused with a named code and the next step in plain words.                                                                                                                                                                                                                                                       |

Every host verb takes `--dry-run`. Long steps run as transient systemd units, so
an ssh drop never stops them. A step that undoes itself (`switch`, `rollback`)
gets a stop timeout longer than the worst case of its undo, computed from the
profile, so systemd never kills the undo half way.

## The ledger

The host keeps an append-only ledger. Every `adopt`, `env set`, `switch` and
`rollback` appends one entry with each service's root, commit, pin sha256 and
env sha256, the previous entry's id and the entry the release started from.
`rollback --to previous` reads its target from there. Steps sharing a `--plan`
roll back together. An `adopt` is a barrier that rollback never crosses.

The ledger line is the last thing a step writes. An error or SIGTERM after it
does not undo the step, so the ledger never names a state the services left.

What the tool owns must still be what the ledger says:

- A pin or env file changed outside the tool is drift. `switch` and `env set`
  refuse it; `rollback` refuses only drift in a file it would write, and leaves
  any other drifted file as it is, with a warning.
- A root moved by a release made outside the tool is named by every verb
  (`ROOT_MOVED:<service>:run adopt --rebaseline`) until `adopt --rebaseline`
  records it. That entry is a barrier too.
- A service or env file added to the profile after the ledger began is named by
  every verb (`NOT_ADOPTED:<name>`: the verbs that write refuse, `verify` fails,
  `rollback` warns, as it touches nothing of it) until `adopt` adds it.

Each service has one tool-owned drop-in: the pin the ledger names. No drop-in
that applies after it may set a key the pin sets. Pin and env versions are kept
in a content-addressed store, so a rollback restores exact bytes. Env files are
read the way systemd reads an `EnvironmentFile`, so a value the service would
read differently is refused.

## Tests

```sh
python3 -I -B scripts/release/tests/run_all.py
ARTVENN_RELEASE_PROFILE=<private profile> python3 -I -B scripts/release/tests/run_all.py
```

With a private profile, `run_all.py` also refuses when a tracked file here holds
one of that profile's host facts. `scripts/release-tool.test.mjs` runs the first
form in the lightweight CI job.
