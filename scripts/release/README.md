# Standing release tool (phase A, and migrate from phase B)

One release tool for every release, instead of a new toolkit each time. Python
standard library only. It never runs in CI against a real host: its tests build
a fake host from a profile.

- `release.py` runs on the operator's machine.
- `release_host.py` runs as root on the host. It is installed once per version,
  next to the host part of the profile, and pinned by sha256. A release payload
  never carries it, so changing the tool does not mean uploading a release
  again. A new version of either needs `install` before its first use.

## The profile is private

Host names, directories, units, ports, env file paths and key names, time-zone
behaviour, the remote command and the live roots all live in a private profile
JSON. It is never committed, because this repository is public. Pass it with
`--profile` or `ARTVENN_RELEASE_PROFILE`. `tests/fixtures/profile.example.json`
shows the shape with fictional values. The host alias is read at run time from
the file the profile names; it is not copied into the profile.

Both sides refuse a profile they would misread: every service must appear in
`restartOrder` exactly once, have a `live` entry, known env files and code
paths, and the checks `verify` reads must be there. `migrate` also needs the
`pg_dump`, `pg_restore` and (App family) `node` tools, `database.cmsRuntimeRole`
(the env file and key whose URL names the CMS runtime login), `database.appRole`
(the same for the App role) and `database.appMigrationService` (the service
whose new root runs the App migrations).

## Verbs

| Verb                                                                                                                             | What it does                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install`                                                                                                                        | Installs the host tool and host profile (idempotent).                                                                                                                                                                                                                                                                                                                 |
| `baseline`, `status`                                                                                                             | Read-only host facts. They also name services the ledger lacks (`notAdopted`) and roots moved outside the tool (`rootMoved`), with the step that fixes them.                                                                                                                                                                                                          |
| `plan <commit> --services a,b [--env FILES:KEY] [--migrations FAMILY:NAME] [--ungranted FAMILY:SCHEMA.TABLE] [--unit-applied S]` | Local git checks plus read-only host facts. Decides per service: new root (its code changed) or restart only. The code paths in the profile are roots; the plan adds the workspace packages they depend on (from `package.json` at both commits) and the root build files. Refuses undeclared pending migrations and changed unit templates (see Migrations below).   |
| `build`                                                                                                                          | Local: the profile's builder, a delta against the live manifests, a payload in parts named by their sha256. With App migrations, their files and the release's launcher go in as blobs.                                                                                                                                                                               |
| `stage`                                                                                                                          | Sends the plan and the missing parts; assembles the payload on the host.                                                                                                                                                                                                                                                                                              |
| `adopt [--rebaseline]`                                                                                                           | Records the live state as the ledger's next entry, adding services and env files the profile gained. `--rebaseline` also records roots a release outside this tool moved.                                                                                                                                                                                             |
| `prepare`                                                                                                                        | New roots, static unions, caches, rendered pins. No service change.                                                                                                                                                                                                                                                                                                   |
| `migrate --family cms\|app --pitr-confirmed [--check]`                                                                           | The plan's migrations of one family, forward only, after `prepare` and before `switch` (see Migrations below). `--check` runs every check on the host and changes nothing. `migrate --family X --rebaseline` records what `verify` compares against, as it is now.                                                                                                    |
| `env set FILES KEY --value-file F \| --generate token64`                                                                         | One key in the named env files and their staged copies. The value never travels on an argv and is never printed.                                                                                                                                                                                                                                                      |
| `switch a,b --plan ID --outage-ok`                                                                                               | Pins, then restarts in the given order. Undoes itself on any failure or SIGTERM. Refused (`MIGRATIONS_NOT_DONE`) while the latest `migrate` of the plan for one of its families did not answer `MIGRATED`. Without `--plan` it is a restart on the same roots, answered `RESTARTED`, and refused (`PLAN_PENDING`) while a staged plan would move one of the services. |
| `verify`                                                                                                                         | Read-only checks, the migration ledgers' row counts and the migrated objects' privileges among them.                                                                                                                                                                                                                                                                  |
| `rollback --to previous --outage-ok [--unswitched-ok]`                                                                           | Back to the state before the latest release. It never touches a migration, and says so (`migrations`). Refused (`UNSWITCHED_PLAN`) while a later plan was prepared or migrated but switched nothing: rolling back then undoes the release before it, which `--unswitched-ok` asks for in so many words.                                                               |
| `close-out --accepted`                                                                                                           | After a PASS verify: removes earlier env versions and old payloads; lists old roots that nothing uses and the migrate dumps that stay.                                                                                                                                                                                                                                |
| `dns`, `cert`, `edgeone`, `nginx`, `unit`                                                                                        | Not built yet. Refused with a named code and the next step in plain words.                                                                                                                                                                                                                                                                                            |
| `check-migrations [--base REF]`                                                                                                  | No profile, no host: the CI check below.                                                                                                                                                                                                                                                                                                                              |

Every host verb takes `--dry-run`. Long steps run as transient systemd units, so
an ssh drop never stops them. A step that undoes itself (`switch`, `rollback`)
gets a stop timeout longer than the worst case of its undo, computed from the
profile, so systemd never kills the undo half way.

## Migrations

Two families: `cms` (Payload's `payload_migrations`, sources under
`apps/admin/src/migrations`) and `app` (the Community `schema_migrations`,
`database/community-migrations`). A release that carries one does this:

1. `plan <commit> --services backend,admin --migrations cms:<name>`. Every
   migration the commit carries and the host's ledger lacks must be declared; an
   undeclared one still answers `MIGRATIONS_PENDING`, and one that sorts before
   the ledger's latest answers `MIGRATION_ORDER`. Each declared one must only
   expand: no `DROP`, `RENAME`, `TRUNCATE`, column type change, `SET NOT NULL`,
   added constraint, added `NOT NULL` column without a default, unique index,
   `DELETE`, `REVOKE`, ownership change, row level security switched on, or
   dynamic `EXECUTE` (its text cannot be read) on an object the same SQL did not
   create. A key, unique or foreign-key constraint or a unique index that covers
   only columns the same SQL added is fine (what Payload writes for a new
   collection). So is a CHECK on such columns, but only when the SQL gives them
   no `DEFAULT` and no `NOT NULL` and the CHECK is a top-level `OR` with a
   `<column> IS NULL` branch for every column it reads
   (`kind IS NULL OR kind IN (...)`): the earlier code leaves them NULL. Any
   other CHECK (`kind IS NOT NULL`, `coalesce(n, 0) > 0`, `n > 0`, or one on a
   column with a default) is `ADD_CONSTRAINT`. A constraint accepted this way
   hides nothing else the same statement does. DO block bodies are read;
   function bodies are not (they run when called). Replacing a CHECK with
   `DROP CONSTRAINT ..., ADD CONSTRAINT ...` counts as a contraction, even when
   the new one is wider. What the Owner approves anyway is written into the
   migration's SQL as a comment naming exactly those problems,
   `-- release: contraction-ok DROP:community.works ADD_CONSTRAINT:community.works (reason)`:
   the plan accepts them and names them (`MIGRATION_CONTRACTION_OK`), and a mark
   that names nothing found refuses (`MARK_UNUSED`). An `UPDATE` of existing
   rows, a `CREATE OR REPLACE` or a trigger on an existing table is named
   (`MIGRATION_NOTE`), never refused.

   A CMS migration's `up()` body must be exactly one
   ``await db.execute(sql`...`)`` (comments around it are fine) with no
   `sql.raw`, no `${}`, no backslash, no psql variable (`:name` outside quotes),
   no transaction control and nothing that changes the session (`SET`, `RESET`,
   `set_config`): the plan carries that SQL pinned by sha256. The plan also pins
   the CMS runtime grant file (`infra/development/grant-cms-runtime.sql`) and
   works out, for each table the migrations create, the table privileges it
   grants, the ones that must stay absent and the columns it grants privileges
   on; the same for each sequence they create, a serial or identity column's
   among them (named as PostgreSQL names it). A new table the file grants
   nothing on refuses (`GRANT_FILE_MISSES_NEW_TABLE`) unless declared
   `--ungranted cms:<schema.table>` (only for a table the role is to have
   nothing on); a serial column's sequence must be usable wherever its table
   takes INSERT (`GRANT_FILE_MISSES_SEQUENCE`). Besides plain `GRANT`s, a DO
   block counts when every statement in it is
   `EXECUTE format('GRANT <privileges> ON TABLE <schema.table> TO %I', current_setting('<setting>'))`,
   the text a constant, under at most one
   `IF to_regclass('<relation>') IS NOT NULL` guard, and the file bound that
   setting to the role's variable before
   (`SET LOCAL moya.runtime_app_role = :"app_role"`); such a grant counts for
   the objects the release creates only. For an App migration that creates
   tables, the plan reads the App grant file
   (`infra/development/work-publishing/grant-runtime.sql`) the same way; this
   tool never runs that file. The category becomes `+migration`, and the plan
   writes the order: `sequence` (`migrate --family cms`, then
   `switch backend,admin`). An App migration needs the new root of
   `database.appMigrationService` in the plan. A CMS grant file that changed
   since the live commit of a service that logs in as the CMS runtime role is
   run before that service switches, migration or not (`+grants`,
   `GRANT_FILE_CHANGED:cms`).

2. `build`, `stage`, `adopt` if needed, `prepare`.
3. `migrate --family cms --check` (any time; `--family app` after `prepare`):
   what is pending, the objects a dump would hold, the room for it, the runtime
   role, whether every relation the grant file names exists (`missing`) and
   belongs to the migration role (`notOwned`), what the migrating role's default
   privileges would give the runtime role or PUBLIC on the new objects against
   what must stay absent (`conflicts`), the grant file rehearsed in a
   transaction that is rolled back, so its own guards speak (`grantRehearsal`;
   every statement naming an object the release creates, of any kind, is left
   out, as it is not there yet), and for `app` the modules the launcher imports
   from the new root (`modulesMissing`). `ready` is true when nothing stands in
   the way.
4. `migrate --family cms --pitr-confirmed`, inside the release window. The
   backup rule the Owner approved: TencentDB's automatic backup and
   point-in-time recovery are the backup, and the operator confirms in the
   console that they are on (`--pitr-confirmed`, refused without it). Whatever
   `--check` would report as not ready refuses here before anything changes. The
   host then, after the time guards, dumps only the relations the remaining
   migrations name plus the ledger table (`pg_dump --table`, custom format,
   written as `.partial`, read back with `pg_restore --list` with every relation
   in it, a sha256 sidecar, then renamed; mode 0600, under the state directory's
   `backups/`), and keeps at most two dumps: older ones go once a new one is
   verified, and a partial file or a dump without a matching sidecar is removed
   and never counted. It needs free space of three times those relations plus 4
   GiB. Each CMS migration then runs with its `payload_migrations` row in one
   psql `--single-transaction` call (a row already there refuses first), as the
   CMS migration role, with a 5 s lock timeout. The App family runs the
   release's own launcher (`scripts/migrate-community.mjs`) from a tree that
   holds it, the migration directory and `services` pointing at the new root;
   its compiled runner applies each migration in its own transaction with its
   ledger row (it names no cause on a failure; `applied` and `ledgers` show what
   committed). For `cms` the host then runs the pinned grant file as the
   migration role (`-v cms_role=<runtime role>`, one transaction; idempotent).
   Then it reads the privileges back for the role they are about (the CMS
   runtime role; for `app` the App role): every new table's and sequence's both
   ways (what the file grants is there, every other privilege, DELETE and
   TRUNCATE among them, is not), each column grant, and for `cms` every
   privilege the file grants on objects that existed, schema USAGE among them.
   Any mismatch stops (`PRIVILEGES_NOT_AS_EXPECTED`; for `app`,
   `APP_GRANTS_MISSING`: run the App grant file outside this tool, then
   `migrate` again).
5. `switch backend`, then `switch admin` (or `switch backend,admin`).

Forward only: nothing is ever undone. A failure stops with what was applied
(`applied`) and `REFUSED`; fix the cause and run `migrate` again: it resumes
after the last applied migration, keeps the dump taken before the first of the
plan's migrations committed (with nothing committed yet it takes a new one), and
refuses if the ledger moved in any other way since the plan
(`LEDGER_MOVED_SINCE_PLAN`). No service was switched: do not run `rollback`
after a failed `migrate` (it would undo the release before this one, and refuses
unless `--unswitched-ok`). `migrate` writes no ledger entry, and `rollback`
never runs a down migration: the schema stays and the earlier code runs on it,
which is why migrations only expand. `verify` reports both ledgers' row counts
and, against the latest `MIGRATED` (or later `BASELINED`) run of each family,
fails on a different count (`LEDGER_COUNT`), a migration it applied gone
(`LEDGER_MISSING`), a privilege it checked changed (`PRIVILEGES`), or an object
whose privileges it checked dropped or renamed (`PRIVILEGE_OBJECT_GONE:<name>`,
each read guarded so one gone object never fails the whole read). After a change
made outside this tool (a ledger row, a grant, an object dropped or renamed),
`migrate --family X --rebaseline` records the count and those privileges as they
are now (`BASELINED`, with what changed; a gone object leaves the baseline and
is listed in `changes.gone`), and `verify` compares against that.

### The CI check

`release.py check-migrations --base <main>` reads the repository alone. Against
the base it fails when a new App migration file or a new CMS migration name does
not sort after the latest one there, when the CMS index is out of name order,
when a new migration does more than expand (marks as above accepted, and
reported with the notes), or when a new CMS migration's SQL cannot be extracted.
Migrations already on the base are never re-judged.
`scripts/release-tool.test.mjs` runs it with CI's `BASE_SHA`, or `origin/main`
elsewhere.

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
form in the lightweight CI job, and the migration check above.

`tests/rehearsal.py` runs the CMS migrate step against a real PostgreSQL 16 in a
local task container (synthetic data, roles laid out like Production's: a
migration role owning the CMS tables, a separate runtime role), with the
repository's grant file. Run it before a release whose grant file or migrate
step changed; it is not part of `run_all.py`.
