import process from "node:process";
import console from "node:console";
import { randomBytes } from "node:crypto";
import { readFile as readSource, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import {
  boundedChildLimit,
  bootstrapFailureCategory,
  createVerificationSession,
  resolveCmsBudget,
  syntheticDatabase,
  timeCategories,
  verifyLoopbackDisposableTarget,
  verificationRoot as root,
} from "./verify-cms.mjs";

/**
 * Agent Connections V1 (Issue #141 r15 §6, §10) — the Development-mode
 * acceptance harness.
 *
 * WHY THIS EXISTS SEPARATELY, and why it does not replace anything: the
 * committed production harness boots
 * `apps/admin/.next/standalone/apps/admin/server.js`, which hard-sets
 * `process.env.NODE_ENV = 'production'` before anything else runs. By then the
 * production compile has already folded away every `NODE_ENV === "development"`
 * branch, so a Development-gated surface is not "disabled" there — it is
 * ABSENT FROM THE EMITTED JAVASCRIPT. No environment variable can bring it
 * back, and forcing one would only make the harness lie.
 *
 * So this boots a real `next dev`, and the production harness stays exactly as
 * it is: it remains the evidence that these surfaces are not reachable in
 * Production. Two harnesses, two claims, neither standing in for the other.
 *
 * Everything it owns, it makes and removes: its own synthetic database, its
 * own authorization listener, its own Admin, its own browser. It never touches
 * the retained Development database, another task's container, or the shared
 * browser runner's configuration.
 */

/** Cold `next dev` compiles on demand; bounded by the session regardless. */
const ADMIN_START_MS = 120_000;
const AUTH_START_MS = 20_000;
const BACKEND_START_MS = 20_000;

const expectedStages = [
  "landing-is-unauthenticated",
  "owner-continues-same-origin",
  "review-shows-the-request",
  "consent-approved",
  "token-issued",
  "mcp-initialize",
  "mcp-tools-list-is-read-only",
  // The three business-read stages. The list is compared EXACTLY, so a run
  // that skipped one -- or that reordered the revocation around it -- fails
  // here rather than reporting a shorter success.
  "backend-read-returns-the-seeded-record",
  "mcp-forbidden-tool-denied",
  "revoked-token-denied",
  "backend-read-denied-after-disconnect",
  "reconnect-issues-new-access",
  "old-token-still-denied",
  "backend-read-restored-by-fresh-consent",
];

/**
 * The restart check is the ORCHESTRATOR's, not the browser's: only the
 * process that started the services can stop and start them. The two tokens
 * cross that boundary in a mode-restricted file, never on stdout.
 */
const RESTART_STAGE = "restart-preserves-the-result";

const freePort = () =>
  new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") {
        socket.close();
        reject(new Error("LOCAL_PORT_UNAVAILABLE"));
        return;
      }
      socket.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

/**
 * Waits for a listener, bounded by the session and by its own deadline. It
 * never follows a redirect and never reads a body: readiness is a status code
 * on a route this harness chose, not whatever a server decided to say.
 */
const waitForListener = async (session, name, url, limitMs, child) => {
  const deadline = Date.now() + boundedChildLimit(limitMs, session.remaining());
  for (;;) {
    session.assertActive();
    try {
      const response = await globalThis.fetch(url, {
        redirect: "manual",
        cache: "no-store",
        signal: globalThis.AbortSignal.any([
          session.signal,
          globalThis.AbortSignal.timeout(3000),
        ]),
      });
      if (response.status < 500) return;
    } catch {
      /* bounded startup; never follow another target */
    }
    if (
      Date.now() >= deadline ||
      (child &&
        (!child.child.pid ||
          child.child.exitCode !== null ||
          child.child.signalCode !== null))
    )
      // Which service, and — when it refused rather than crashed — which
      // rule. Both are fixed vocabularies: a service name this file chose,
      // and a BARE CODE the service printed, matched against a pattern that
      // admits nothing but upper-case letters, digits and underscores. A
      // value, a URL or a credential cannot travel through either.
      //
      // The first CI run of this step failed with a bare
      // HARNESS_SERVICE_START_FAILED, which named neither the service nor
      // the reason and left nothing to do but guess. That is the whole point
      // of this block.
      throw new Error(
        `HARNESS_${name}_START_FAILED${await refusalOf(session, child)}`,
      );
    await delay(250, undefined, { signal: session.signal });
  }
};

/**
 * A child's own bare code, or nothing. Never its raw output.
 *
 * WAITS FOR `close` FIRST, and that is the whole reason this exists as a
 * function. `exitCode` is set on the child's `exit` event, which fires BEFORE
 * its stdout and stderr are drained, so reading the captured output the
 * moment the exit is noticed can — and on CI did — return an empty string for
 * a process that had already printed its refusal. The first instrumented run
 * reported HARNESS_BACKEND_START_FAILED with no code for exactly that reason.
 *
 * Two fixed vocabularies are admitted and nothing else: this repository's own
 * `refused: CODE` line, and Node's own error codes (`ERR_MODULE_NOT_FOUND`,
 * `EADDRINUSE`, and the rest), which are identifiers rather than values. A
 * path, a URL, a credential or a message cannot travel out through either.
 */
const refusalOf = async (session, child) => {
  if (!child) return "";
  let output = "";
  try {
    await Promise.race([
      child.closed,
      delay(2000, undefined, { signal: session.signal }),
    ]);
    output = child.output();
  } catch {
    return "";
  }
  const refused = /refused:\s*([A-Z][A-Z0-9_]{2,63})\b/u.exec(output);
  if (refused) return `_${refused[1]}`;
  const node =
    /\b(ERR_[A-Z0-9_]{2,48})\b/u.exec(output) ??
    /code:\s*'([A-Z][A-Z0-9_]{2,48})'/u.exec(output);
  return node ? `_${node[1]}` : "";
};

/**
 * A real stop, not a hopeful one. Children are detached, so the negative pid
 * is their process group and the whole tree goes with it. A "restart" that
 * left the old process listening would be testing the same processes twice,
 * which is exactly the reassurance this check exists to refuse.
 */
const stopService = async (session, managed) => {
  const pid = managed?.child?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const hard = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 5000);
  try {
    await managed.closed;
  } finally {
    clearTimeout(hard);
  }
};

/** Waits until a listener stops answering, so a restart cannot reuse it. */
const waitForSilence = async (session, url, limitMs) => {
  const deadline = Date.now() + boundedChildLimit(limitMs, session.remaining());
  for (;;) {
    session.assertActive();
    try {
      await globalThis.fetch(url, {
        redirect: "manual",
        cache: "no-store",
        signal: globalThis.AbortSignal.any([
          session.signal,
          globalThis.AbortSignal.timeout(1000),
        ]),
      });
    } catch {
      return;
    }
    if (Date.now() >= deadline) throw new Error("HARNESS_SERVICE_STOP_FAILED");
    await delay(200, undefined, { signal: session.signal });
  }
};

async function main() {
  const budget = resolveCmsBudget(process.argv.slice(2));
  // The harness owns a database of its own rather than sharing the cms job's:
  // it creates and drops SQL roles and applies the community migrations,
  // none of which belongs in the database the other CMS checks share. (A
  // leftover synthetic Owner no longer forces this on its own: the bootstrap
  // namespaces its identities per session, so the production browser harness
  // that runs afterwards never refuses on an earlier run's rows.)
  const parent = new URL(syntheticDatabase(process.env.CMS_TEST_DATABASE_URL));
  const owned = `${parent.pathname.slice(1)}_agent_conn_${randomBytes(4).toString("hex")}`;
  // Built from an operator environment variable, so it is CHECKED rather than
  // quoted and hoped for: PostgreSQL has no bind parameter for an identifier,
  // and `syntheticDatabase` validates the URL, not this shape.
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(owned))
    throw new Error("HARNESS_DATABASE_NAME_INVALID");
  const admin = new URL(parent.href);
  admin.pathname = "/postgres";
  const target = new URL(parent.href);
  target.pathname = `/${owned}`;

  // THE SESSION COMES FIRST, and the order is load-bearing. It validates the
  // URL and makes its own temporary directory; it opens no connection, so it
  // can exist before the database does -- and it has to, because the builds
  // below run through it and everything after them needs their output.
  //
  // An earlier arrangement imported `catalog-postgres/dist` at the top of
  // this function, before the build stages that produce it. On a tree where
  // the cms job had already built that package it worked; on a genuinely
  // cold one the harness could not start at all, which is precisely the
  // property the build stages exist to provide. Caught by running against a
  // container matching CI's PostgreSQL with every dist removed.
  const session = await createVerificationSession(
    target.href,
    "moya-agent-connections-",
    budget.sessionBudgetMs,
  );
  console.log(
    `Agent connections profile ${budget.profile}: ceiling ${budget.ceilingMs}ms (${budget.ceilingSource}); session ${budget.sessionBudgetMs}ms`,
  );
  let created = false;
  let control;
  let createPostgresPool;
  let parsePostgresConfig;
  let closePostgresPool;

  /**
   * The three roles this harness creates, uses and drops. Names carry the
   * database's own random suffix so two runs never collide, and PostgreSQL
   * bounds an identifier at 63 bytes.
   */
  const roleNames = {
    provider_role: `${owned}_provider`.slice(0, 63),
    consent_role: `${owned}_consent`.slice(0, 63),
    resource_role: `${owned}_resource`.slice(0, 63),
    backend_role: `${owned}_backend`.slice(0, 63),
  };
  const rolePasswords = Object.fromEntries(
    Object.keys(roleNames).map((key) => [key, randomBytes(24).toString("hex")]),
  );
  /** A loopback connection string for one of them. */
  const asRole = (key) => {
    const url = new URL(target.href);
    url.username = roleNames[key];
    url.password = rolePasswords[key];
    return url.href;
  };

  let summary;
  let operationError;
  let handoff;
  let tokenFile;
  let ownedDistDir;
  let nextEnvPath;
  let nextEnvBefore;
  try {
    // The workspaces this harness STARTS, built before it starts them.
    //
    // Every one of these is loaded from `dist` at runtime -- the
    // authorization listener, the Backend, and the adapters both of them and
    // the Admin's Payload config reach through. A stale or missing `dist` is
    // the single failure this task has hit most often: the source is right,
    // the run is green locally on an already-built tree, and CI fails on a
    // module that was never compiled. Building them here makes the local run
    // and the CI run the same run. Measured at 6 s from a cold tree.
    for (const [name, project] of [
      ["contracts-build", "packages/contracts"],
      ["search-build", "packages/search"],
      // `backend-runtime` imports `@moya/public-api` for its health handler.
      // Missing it is what made CI fail with ERR_MODULE_NOT_FOUND while every
      // local run passed: a `dist` an earlier build had left behind is
      // indistinguishable from one this harness produced, right up until the
      // tree is genuinely clean.
      ["public-api-build", "services/public-api"],
      ["api-build", "services/api"],
      ["catalog-postgres-build", "services/catalog-postgres"],
      ["image-build", "packages/image"],
      ["community-postgres-build", "services/community-postgres"],
      ["backend-runtime-build", "services/backend-runtime"],
      ["agent-authorization-build", "services/agent-authorization"],
    ]) {
      // `session.run` throws VERIFICATION_CHILD_FAILED on a non-zero exit,
      // so a failed compile stops the harness here. An added `if (!ok)` check
      // would have been dead code reading a field `run` never returns.
      await session.run(
        ["node_modules/typescript/bin/tsc", "-p", `${project}/tsconfig.json`],
        root,
        name,
        session.env,
      );
      console.log(`Agent connections ${name}: PASS`);
      session.assertActive();
    }

    // Only now does anything resolve from `dist`, and only now is there a
    // database to put anything in.
    ({ createPostgresPool, parsePostgresConfig, closePostgresPool } =
      await import(path.join(root, "services/catalog-postgres/dist/index.js")));

    // The TARGET this harness was pointed at must itself be a marked
    // disposable one, checked before the first DDL touches the cluster.
    //
    // `syntheticDatabase` validated a NAME, and the whole premise of the
    // marker is that a name proves nothing. Every other entry point that
    // issues DDL asserts this; an independent review pointed out that this
    // one -- a new entry point that runs CREATE DATABASE, CREATE ROLE, DROP
    // OWNED BY, DROP DATABASE and DROP ROLE -- did not. The objects it drops
    // all carry its own random suffix, so nothing else was ever reachable;
    // that makes this an invariant it was relying on rather than asserting.
    await verifyLoopbackDisposableTarget(process.env);

    control = createPostgresPool(
      parsePostgresConfig({ DATABASE_URL: admin.href }),
    );
    await control.query(`CREATE DATABASE "${owned}"`);
    created = true;

    const pool = createPostgresPool(
      parsePostgresConfig({ DATABASE_URL: target.href }),
    );
    try {
      // The disposable marker, on a database this harness just made. The
      // guard refuses the live Development database by name and any name
      // without a whole "test" or "synthetic" segment.
      const { readFile } = await import("node:fs/promises");
      await pool.query(
        await readFile(
          path.join(root, "infra/test/disposable-test-target.sql"),
          "utf8",
        ),
      );
      const { runCommunityMigrations } = await import(
        path.join(root, "services/community-postgres/dist/index.js")
      );
      await runCommunityMigrations(
        pool,
        path.join(root, "database/community-migrations"),
      );
      // The three narrow roles, from the file that ships rather than a copy.
      //
      // The harness then RUNS AS THEM. An earlier version created the roles
      // and connected every pool as the database owner that had just issued
      // CREATE DATABASE -- so the role split was described in comments and
      // exercised nowhere, which an independent review said plainly and which
      // is how a table-level INSERT on the consent table survived.
      //
      // Each password is random per run, so the committed synthetic constants
      // in the grant file never become live credentials on this cluster.
      const client = await pool.connect();
      try {
        for (const [key, value] of Object.entries(roleNames))
          await client.query("SELECT set_config($1,$2,false)", [
            `agent_connections.${key}`,
            value,
          ]);
        await client.query(
          await readFile(
            path.join(
              root,
              "infra/development/agent-connections/grant-authorization.sql",
            ),
            "utf8",
          ),
        );
        for (const [key, name] of Object.entries(roleNames))
          // Both halves escaped. The generator is hex, so the literal was
          // safe -- but an asymmetry where the identifier is escaped and the
          // value beside it is not is exactly what somebody copies later.
          await client.query(
            `ALTER ROLE "${name.replaceAll('"', '""')}" PASSWORD '${rolePasswords[
              key
            ].replaceAll("'", "''")}'`,
          );
      } finally {
        client.release();
      }
    } finally {
      await closePostgresPool(pool);
    }

    session.assertActive();
    const adminRoot = path.join(root, "apps/admin");
    handoff = path.join(session.directory, "access.json");
    tokenFile = path.join(session.directory, "tokens.json");
    // The Payload schema, then the synthetic Owner. A fresh database has the
    // community migrations from above and nothing Payload owns, so the
    // bootstrap would otherwise fail on a missing `users` relation.
    await session.run(
      ["node_modules/payload/bin.js", "migrate"],
      adminRoot,
      "payload-migrate",
      session.env,
    );
    console.log("Agent connections payload-migrate: PASS");
    await session.run(
      ["node_modules/payload/bin.js", "run", "scripts/bootstrap-synthetic.ts"],
      adminRoot,
      "bootstrap",
      { ...session.env, CMS_QA_HANDOFF_FILE: handoff },
      { categorize: bootstrapFailureCategory },
    );
    console.log("Agent connections bootstrap: PASS");

    // The fixture the acceptance read asks for, by an exact handle nothing
    // else uses. Seeded through the same synthetic account path the community
    // suites use, in the harness's own database.
    const seededHandle = `acc-${randomBytes(6).toString("hex")}`;
    const seededUserId = `user-${randomBytes(16).toString("hex")}`;
    const seededDisplayName = `Acceptance ${seededHandle}`;
    const operatorToken = randomBytes(32).toString("hex");

    const distDir = `.next-acceptance-${randomBytes(4).toString("hex")}`;
    ownedDistDir = distDir;
    // `next dev` rewrites `next-env.d.ts` to point at ITS dist directory.
    // That is a source file, and a harness that left it rewritten would break
    // everyone else's type-check while looking like a passing run. Kept
    // verbatim and put back, whatever happens after this line.
    nextEnvPath = path.join(adminRoot, "next-env.d.ts");
    nextEnvBefore = await readSource(nextEnvPath, "utf8");
    const [
      authPort,
      adminPort,
      redirectPort,
      backendPort,
      hostRedirectPort,
      genericRedirectPort,
    ] = await Promise.all([
      freePort(),
      freePort(),
      freePort(),
      freePort(),
      freePort(),
      freePort(),
    ]);
    // Two DIFFERENT hostnames, both universally resolvable. Cookies are
    // host-scoped and not port-scoped, so an issuer and a consent page sharing
    // a host would share a cookie jar — which is the one thing this whole
    // design cannot tolerate. `localhost` and `127.0.0.1` are also different
    // sites to the browser, which is what makes the SameSite behaviour real
    // rather than simulated.
    const issuer = `http://127.0.0.1:${authPort}`;
    const adminOrigin = `http://localhost:${adminPort}`;
    const resource = `${adminOrigin}/api/mcp`;
    const redirectUri = `http://127.0.0.1:${redirectPort}/callback`;
    // Loopback only, and its own port. The Admin reaches the Backend over
    // this and nothing else reaches it at all.
    const backendOrigin = `http://127.0.0.1:${backendPort}`;
    const clientId = "artvenn-acceptance-client";
    // A client whose family is in NONE of the three onboarding presets, and
    // whose registration required no code change to exist. This is what the
    // generic-SDK stage authorizes as, so "any authorized client" is a thing
    // the acceptance actually does rather than a sentence in a document.
    const genericClientId = "artvenn-acceptance-generic";
    const genericRedirectUri = `http://127.0.0.1:${genericRedirectPort}/callback`;
    // And one registered under the permissive callback policy, so the policy
    // is exercised against the real provider rather than only against the
    // registry parser.
    const hostClientId = "artvenn-acceptance-hostname";
    const hostRedirectUri = `http://localhost:${hostRedirectPort}/callback`;
    const clients = JSON.stringify([
      {
        clientId,
        family: "claude",
        label: "Acceptance client",
        redirectUris: [redirectUri],
      },
      {
        clientId: genericClientId,
        family: "acme-agent",
        label: "ACME agent",
        redirectUris: [genericRedirectUri],
      },
      {
        clientId: hostClientId,
        family: "cursor",
        label: "Hostname callback client",
        callbackPolicy: "loopback-host",
        redirectUris: [hostRedirectUri],
      },
    ]);
    // Task-private synthetic keys, generated per run, never printed and never
    // written anywhere but this session's own environment.
    const keys = {
      AGENT_CONNECTION_PROVIDER_INDEX_KEY: randomBytes(32).toString("base64"),
      AGENT_CONNECTION_PROVIDER_SEAL_KEY: randomBytes(32).toString("base64"),
      AGENT_CONNECTION_WRAPPER_INDEX_KEY: randomBytes(32).toString("base64"),
      AGENT_CONNECTION_WRAPPER_SEAL_KEY: randomBytes(32).toString("base64"),
    };
    // Seeding, all of it through this harness's own database and the
    // supported adapters, before any service starts.
    const seedPool = createPostgresPool(
      parsePostgresConfig({ DATABASE_URL: target.href }),
    );
    try {
      // One synthetic public user, by an exact handle nothing else uses.
      await seedPool.query(
        `INSERT INTO community.public_users (id, handle, display_name, status)
         VALUES ($1,$2,$3,'active')`,
        [seededUserId, seededHandle, seededDisplayName],
      );
      // NOTHING ELSE IS SEEDED, and the absence is the test.
      //
      // This block used to write the machine principal through the database
      // owner and pre-create the connection row carrying its label, because
      // consent registered no principal and a connection it created would
      // have been refused by the Backend on every tool. That made the harness
      // pass over a product that could not onboard anybody: the only working
      // first connection was one a developer had built by hand.
      //
      // Consent now provisions the principal itself, so the harness creates
      // NO principal and NO connection. What the acceptance exercises is the
      // real first-connection path — `resolveConnection` opens the row,
      // `decideConsent` provisions its identity, and the Backend authorizes
      // against a registry row nobody seeded.
    } finally {
      await closePostgresPool(seedPool);
    }

    const shared = {
      ...session.env,
      ...keys,
      CMS_QA_HANDOFF_FILE: handoff,
      CMS_QA_ACCESS_FILE: handoff,
      AGENT_ACCEPTANCE_TOKEN_FILE: tokenFile,
      NODE_ENV: "development",
      AGENT_CONNECTIONS_ENABLED: "true",
      AGENT_AUTHORIZATION_ENABLED: "true",
      AGENT_AUTHORIZATION_ISSUER: issuer,
      AGENT_AUTHORIZATION_RESOURCE: resource,
      AGENT_AUTHORIZATION_CONSENT_URL: adminOrigin,
      AGENT_AUTHORIZATION_PORT: String(authPort),
      AGENT_AUTHORIZATION_CLIENTS: clients,
      AGENT_AUTHORIZATION_ENVIRONMENT: "development",
      // Each service authenticates as its OWN role, so the grant plan is the
      // thing under test rather than a paragraph about one.
      AGENT_AUTHORIZATION_DATABASE_URL: asRole("provider_role"),
      AGENT_CONSENT_DATABASE_URL: asRole("consent_role"),
      AGENT_RESOURCE_DATABASE_URL: asRole("resource_role"),
      // The loopback operator channel the Admin's MCP tools forward over.
      // Without these the tools answer OPERATOR_NOT_CONFIGURED and the
      // acceptance read cannot happen, which is exactly the state this
      // milestone's earlier `backendToolRead: NOT_RUN` recorded.
      COMMUNITY_OPERATOR_BASE_URL: backendOrigin,
      COMMUNITY_OPERATOR_TOKEN: operatorToken,
    };

    /** Starts all three services and waits for each to answer. */
    const startServices = async (startMs) => {
      // The Backend first: the Admin's tools forward to it, and a restart
      // that brought the Admin back without it would report a transport
      // failure as a revocation.
      const backend = session.start(
        ["scripts/editorial/agent-connections-backend.mjs"],
        root,
        {
          ...shared,
          AGENT_ACCEPTANCE_BACKEND_ENABLED: "true",
          AGENT_ACCEPTANCE_BACKEND_DATABASE_URL: asRole("backend_role"),
          AGENT_ACCEPTANCE_BACKEND_PORT: String(backendPort),
        },
      );
      await waitForListener(
        session,
        "BACKEND",
        `${backendOrigin}/health`,
        BACKEND_START_MS,
        backend,
      );
      const auth = session.start(
        ["services/agent-authorization/dist/main.js"],
        root,
        shared,
      );
      await waitForListener(
        session,
        "AUTHORIZATION",
        `${issuer}/healthz`,
        AUTH_START_MS,
        auth,
      );
      const admin_ = session.start(
        [
          "node_modules/next/dist/bin/next",
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(adminPort),
        ],
        adminRoot,
        {
          ...shared,
          PORT: String(adminPort),
          HOSTNAME: "127.0.0.1",
          // Its own build directory, so the harness never contends with a
          // dev server somebody else is running and never has to stop one.
          MOYA_ADMIN_DIST_DIR: distDir,
        },
      );
      await waitForListener(
        session,
        "ADMIN",
        `${adminOrigin}/admin/login`,
        startMs,
        admin_,
      );
      return { backend, auth, admin: admin_ };
    };

    let services = await startServices(ADMIN_START_MS);

    const browser = session.start(
      ["tests/cms/agent-connections-browser.mjs"],
      root,
      {
        ...shared,
        AGENT_ACCEPTANCE_ADMIN_ORIGIN: adminOrigin,
        AGENT_ACCEPTANCE_ISSUER: issuer,
        AGENT_ACCEPTANCE_RESOURCE: resource,
        AGENT_ACCEPTANCE_CLIENT_ID: clientId,
        AGENT_ACCEPTANCE_REDIRECT_URI: redirectUri,
        AGENT_ACCEPTANCE_SEEDED_HANDLE: seededHandle,
        AGENT_ACCEPTANCE_SEEDED_USER_ID: seededUserId,
        AGENT_ACCEPTANCE_SEEDED_DISPLAY_NAME: seededDisplayName,
      },
    );
    const browserCode = await browser.closed;
    const frames = browser
      .output()
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const results = frames.filter((item) => typeof item.ok === "boolean");
    summary = results.length === 1 ? results[0] : null;
    if (browserCode !== 0 || summary?.ok !== true) {
      // Fixed stage names only. No child diagnostics, no response bodies, no
      // URLs, no token, no cookie and no arbitrary exception message.
      console.log(
        JSON.stringify({
          syntheticAgentConnections: "FAIL",
          stage: /^[a-z][a-z-]{0,95}$/.test(summary?.stage ?? "")
            ? summary.stage
            : "unrecognized-browser-result",
          completed: expectedStages.filter((stage) =>
            summary?.completed?.includes(stage),
          ),
          // A bare refusal code names a rule, never a value.
          refusalCode: /^[A-Z][A-Z0-9_]{2,63}$/.test(summary?.refusalCode ?? "")
            ? summary.refusalCode
            : undefined,
          // One of two fixed words. Without it a failing run says which stage
          // stopped but not whether the business read ever happened, which is
          // the single fact this milestone is judged on.
          backendToolRead:
            summary?.backendToolRead === "VERIFIED" ? "VERIFIED" : "NOT_RUN",
        }),
      );
      throw new Error("AGENT_CONNECTIONS_CHECK_FAILED");
    }
    if (
      !Array.isArray(summary.completed) ||
      JSON.stringify(summary.completed) !== JSON.stringify(expectedStages)
    )
      throw new Error("AGENT_CONNECTIONS_RESULT_INCOMPLETE");
    // The acceptance gate for this milestone, checked BEFORE the restart work
    // so no later success can stand in for it. A missing Backend, a skipped
    // positive read or a setup refusal all arrive here as something other
    // than VERIFIED, and all of them fail — the earlier authentication stages
    // passing is exactly the situation this refuses to accept as evidence.
    if (summary.backendToolRead !== "VERIFIED")
      throw new Error("BACKEND_TOOL_READ_NOT_VERIFIED");
    session.assertActive();

    // What the REAL provider does with a callback, against the policy this
    // repository records. A separate child because it drives the
    // authorization service directly and completes no flow — the registry's
    // unit tests decide what may be REGISTERED, and only this can say what
    // the provider will REDEEM.
    const policy = session.start(
      ["tests/cms/agent-connections-callback-policy.mjs"],
      root,
      {
        ...shared,
        AGENT_ACCEPTANCE_ISSUER: issuer,
        AGENT_ACCEPTANCE_RESOURCE: resource,
        AGENT_ACCEPTANCE_CLIENT_ID: clientId,
        AGENT_ACCEPTANCE_REDIRECT_URI: redirectUri,
        AGENT_ACCEPTANCE_HOST_CLIENT_ID: hostClientId,
        AGENT_ACCEPTANCE_HOST_REDIRECT: hostRedirectUri,
      },
    );
    const policyCode = await policy.closed;
    const policyResult = policy
      .output()
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((item) => item && typeof item.ok === "boolean")
      .at(-1);
    if (policyCode !== 0 || policyResult?.ok !== true) {
      console.log(
        JSON.stringify({
          syntheticAgentConnections: "FAIL",
          check: "callback-policy",
          stage: /^[a-z][a-z-]{0,95}$/.test(policyResult?.stage ?? "")
            ? policyResult.stage
            : "unrecognized-policy-result",
        }),
      );
      throw new Error("CALLBACK_POLICY_CHECK_FAILED");
    }
    summary.completed.push(...(policyResult.completed ?? []));
    session.assertActive();

    // An UNFAMILIAR client, using the official MCP SDK, told nothing but the
    // server URL and its own registration. The browser acceptance above
    // proves the product works; only this proves it is DISCOVERABLE, because
    // only this has to discover anything.
    const generic = session.start(
      ["tests/cms/agent-connections-generic-client.mjs"],
      root,
      {
        ...shared,
        AGENT_ACCEPTANCE_ADMIN_ORIGIN: adminOrigin,
        AGENT_ACCEPTANCE_RESOURCE: resource,
        AGENT_ACCEPTANCE_ISSUER: issuer,
        AGENT_ACCEPTANCE_GENERIC_CLIENT_ID: genericClientId,
        AGENT_ACCEPTANCE_GENERIC_REDIRECT: genericRedirectUri,
        AGENT_ACCEPTANCE_SEEDED_HANDLE: seededHandle,
        AGENT_ACCEPTANCE_SEEDED_USER_ID: seededUserId,
        AGENT_ACCEPTANCE_SEEDED_DISPLAY_NAME: seededDisplayName,
      },
    );
    const genericCode = await generic.closed;
    const genericResult = generic
      .output()
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((item) => item && typeof item.ok === "boolean")
      .at(-1);
    if (genericCode !== 0 || genericResult?.ok !== true) {
      console.log(
        JSON.stringify({
          syntheticAgentConnections: "FAIL",
          check: "generic-client",
          stage: /^[a-z][a-z-]{0,95}$/.test(genericResult?.stage ?? "")
            ? genericResult.stage
            : "unrecognized-generic-result",
        }),
      );
      throw new Error("GENERIC_CLIENT_CHECK_FAILED");
    }
    summary.completed.push(...(genericResult.completed ?? []));
    session.assertActive();

    // Restart both services against the SAME stores and the SAME keys. The
    // question is whether the result survives a process, not whether it
    // survives a request: a revocation that lived only in memory would come
    // back to life here, and a wrapper sealed under a regenerated key would
    // stop resolving for everyone at once.
    await stopService(session, services.admin);
    await stopService(session, services.auth);
    await stopService(session, services.backend);
    await waitForSilence(session, `${issuer}/healthz`, 15_000);
    await waitForSilence(session, `${adminOrigin}/admin/login`, 15_000);
    await waitForSilence(session, `${backendOrigin}/health`, 15_000);
    services = await startServices(ADMIN_START_MS);
    const { readFile: readTokens } = await import("node:fs/promises");
    const tokens = JSON.parse(await readTokens(tokenFile, "utf8"));
    /** One JSON-RPC call against the restarted Admin. */
    const call = async (token, body, sessionId) => {
      const response = await globalThis.fetch(`${adminOrigin}/api/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
        signal: globalThis.AbortSignal.any([
          session.signal,
          globalThis.AbortSignal.timeout(30_000),
        ]),
      });
      const text = await response.text();
      const payload = text.startsWith("event:")
        ? JSON.parse(
            text
              .split("\n")
              .find((line) => line.startsWith("data:"))
              ?.slice(5) ?? "{}",
          )
        : text
          ? JSON.parse(text)
          : {};
      return {
        status: response.status,
        sessionId: response.headers.get("mcp-session-id") ?? sessionId,
        payload,
      };
    };
    const probe = async (token) =>
      call(token, {
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "artvenn-restart", version: "0" },
        },
      });
    /**
     * The restart's own business read. Answers whether the EXACT seeded
     * record came back, never merely whether the endpoint replied: the MCP
     * adapter answers a forbidden principal and an unreachable Backend alike
     * with HTTP 200 and `{ok:false, code}`, so a status check here would have
     * called a dead operator channel a surviving authorization.
     */
    const readsSeededUser = async (token, sessionId) => {
      const answer = await call(
        token,
        {
          method: "tools/call",
          params: {
            name: "artvenn_users_find",
            arguments: { handle: seededHandle, page: 1, pageSize: 20 },
          },
        },
        sessionId,
      );
      if (
        answer.status !== 200 ||
        answer.payload.error !== undefined ||
        answer.payload.result?.isError === true
      )
        return false;
      const text = answer.payload.result?.content?.[0]?.text;
      if (typeof text !== "string") return false;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return false;
      }
      if (parsed?.ok !== true) return false;
      const user = parsed.result?.items?.[0];
      return (
        parsed.result?.total === 1 &&
        parsed.result?.resolution?.userId === seededUserId &&
        user?.id === seededUserId &&
        user?.handle === seededHandle
      );
    };

    const live = await probe(tokens.live);
    if (live.status !== 200) throw new Error("RESTART_LOST_LIVE_ACCESS");
    // Authentication surviving a restart is not the claim; READING survives.
    if (!(await readsSeededUser(tokens.live, live.sessionId)))
      throw new Error("RESTART_LOST_BACKEND_READ");
    const stale = await probe(tokens.stale);
    if (stale.status === 200)
      throw new Error("RESTART_RESTORED_REVOKED_ACCESS");
    // And the revoked token cannot read either, whatever the transport did.
    if (await readsSeededUser(tokens.stale, live.sessionId))
      throw new Error("RESTART_RESTORED_REVOKED_READ");
    summary.completed.push(RESTART_STAGE);
  } catch (error) {
    operationError = error;
  } finally {
    await session.dispose();
    // Only what this harness made. The database is dropped last, after every
    // child is gone, so nothing is holding a connection to it. `created` is
    // false and `control` undefined when a build failed before either
    // existed, which is why both are checked rather than assumed.
    if (created && control) {
      // Roles are CLUSTER-wide, not per-database: dropping the database frees
      // their grants and leaves the LOGIN accounts behind. An independent
      // review caught an earlier version accumulating two of them per run,
      // with the grant file's synthetic passwords, against the developer's
      // own cluster. Owned objects go first, because a role that still owns
      // something cannot be dropped.
      // `DROP OWNED BY` succeeds for a role that owns nothing, so a bare
      // catch here would only ever hide a real failure -- which is what an
      // earlier version did, with a comment claiming the opposite. A failure
      // is recorded; the later `DROP ROLE` is what would then fail loudly.
      // Constructed INSIDE the try: a throw here (realistically only
      // `parsePostgresConfig`) would otherwise replace the original error and
      // skip the database drop, the role drops, the token removal and the
      // source restore below it.
      let scoped;
      try {
        scoped = createPostgresPool(
          parsePostgresConfig({ DATABASE_URL: target.href }),
        );
        for (const name of Object.values(roleNames)) {
          try {
            await scoped.query(`DROP OWNED BY "${name.replaceAll('"', '""')}"`);
          } catch {
            operationError ??= new Error("HARNESS_ROLE_CLEANUP_FAILED");
          }
        }
      } catch {
        operationError ??= new Error("HARNESS_ROLE_CLEANUP_FAILED");
      } finally {
        if (scoped) await closePostgresPool(scoped);
      }
      try {
        await control.query(`DROP DATABASE IF EXISTS "${owned}" WITH (FORCE)`);
      } catch {
        operationError ??= new Error("HARNESS_DATABASE_CLEANUP_FAILED");
      }
      for (const name of Object.values(roleNames)) {
        try {
          await control.query(
            `DROP ROLE IF EXISTS "${name.replaceAll('"', '""')}"`,
          );
        } catch {
          operationError ??= new Error("HARNESS_ROLE_CLEANUP_FAILED");
        }
      }
    }
    if (control) await closePostgresPool(control);
    // The handoff and the tokens go first, then the directory that held them.
    for (const file of [handoff, tokenFile])
      if (file) await rm(file, { force: true });
    if (nextEnvPath && nextEnvBefore !== undefined) {
      try {
        if ((await readSource(nextEnvPath, "utf8")) !== nextEnvBefore)
          await writeFile(nextEnvPath, nextEnvBefore);
      } catch {
        operationError ??= new Error("HARNESS_SOURCE_RESTORE_FAILED");
      }
    }
    if (ownedDistDir)
      await rm(path.join(root, "apps/admin", ownedDistDir), {
        recursive: true,
        force: true,
      });
    await rm(session.directory, { recursive: true, force: true });
  }
  if (session.failure) throw new Error(session.failure);
  if (operationError) throw operationError;
  console.log(
    JSON.stringify({
      syntheticAgentConnections: "PASS",
      stages: summary.completed.length,
      elapsedMs: session.elapsed(),
      ceilingMs: budget.ceilingMs,
      profile: budget.profile,
      // Recorded so the evidence cannot be read as more than it is. A PASS
      // can only ever print VERIFIED here now; the value stays in the summary
      // because a reader should not have to know that to trust it.
      backendToolRead: summary.backendToolRead ?? "NOT_RUN",
    }),
  );
}

main().catch((error) => {
  // Digits allowed: a named stage failure can carry a service's bare refusal
  // code, and those are not restricted to letters. Still a fixed vocabulary —
  // anything else becomes the generic category rather than travelling out.
  const category =
    error instanceof Error && /^[A-Z][A-Z0-9_]{2,127}$/u.test(error.message)
      ? error.message
      : "SYNTHETIC_AGENT_CONNECTIONS_FAILED";
  console.log(JSON.stringify({ syntheticAgentConnections: "FAIL", category }));
  process.exitCode = timeCategories.has(category) ? 124 : 1;
});
