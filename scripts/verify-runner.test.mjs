import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  runWithinBudget,
  verificationCommands,
  verificationPlan,
  verificationWorkspaces,
} from "./verify.mjs";

const delay = (ms) => new Promise((accept) => setTimeout(accept, ms));
const temporary = (t) => {
  const directory = mkdtempSync(join(tmpdir(), "moya-bounded-runner-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const workspaceFixture = (t) => {
  const root = temporary(t);
  for (const [directory, name] of [
    ["apps/web", "web"],
    ["apps/admin", "admin"],
    ["services/backend-runtime", "@moya/backend-runtime"],
    ["packages/contracts", "@moya/contracts"],
    ["tests", "@moya/tests"],
  ]) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(
      join(root, directory, "package.json"),
      JSON.stringify({ name }),
    );
  }
  mkdirSync(join(root, "apps/apple"));
  mkdirSync(join(root, "apps/harmony"));
  return root;
};
const worker = (directory, id, ms = 150) => [
  process.execPath,
  "-e",
  "const fs=require('node:fs');const file=process.argv[1];fs.writeFileSync(file+'.start',String(Date.now()));setTimeout(()=>fs.writeFileSync(file+'.end',String(Date.now())),Number(process.argv[2]));",
  join(directory, String(id)),
  String(ms),
];
const timestamp = (directory, id, suffix) =>
  Number(readFileSync(join(directory, `${id}.${suffix}`), "utf8"));
const waitFor = async (file, timeoutMs = 2000) => {
  const started = Date.now();
  while (!existsSync(file) && Date.now() - started < timeoutMs) await delay(10);
  assert.ok(existsSync(file), `child did not write ${file}`);
};
const stopProcess = (child) => {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};

describe("affected workspace command boundaries", () => {
  it("treats CI workspace output as one validated argument and retains broad fallback", (t) => {
    const root = workspaceFixture(t);
    const selected = verificationPlan(
      "test",
      [],
      {
        MOYA_VERIFY_WORKSPACES: "web,@moya/tests",
      },
      root,
    );
    assert.deepEqual(selected.workspaces, ["@moya/tests", "web"]);
    assert.deepEqual(verificationCommands(selected).at(-1).slice(-2), [
      "--filter=@moya/tests",
      "--filter=web",
    ]);
    for (const env of [{}, { MOYA_VERIFY_WORKSPACES: "" }])
      assert.deepEqual(
        verificationPlan("test", [], env, root),
        verificationPlan("test"),
      );
    for (const value of [
      "web --filter=admin",
      "web\nignored=true",
      "$(touch ignored)",
      "web,missing",
    ])
      assert.throws(() =>
        verificationPlan("test", [], { MOYA_VERIFY_WORKSPACES: value }, root),
      );
    assert.throws(() =>
      verificationPlan(
        "test",
        ["--workspaces", "web"],
        {
          MOYA_VERIFY_WORKSPACES: "web",
        },
        root,
      ),
    );
    writeFileSync(
      join(root, "apps/web/package.json"),
      JSON.stringify({ name: "web\nignored=true" }),
    );
    assert.throws(() => verificationWorkspaces(root), /valid package name/u);
  });

  it("passes classifier data through environment fields in the same four cumulative CI jobs", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const jobs = new Map(
      [
        ...workflow.matchAll(/^  ([\w-]+):\n((?:(?!^  [\w-]+:\n)[\s\S])*)/gmu),
      ].map((match) => [match[1], match[2]]),
    );
    assert.match(
      jobs.get("classify_e2e"),
      /web_workspaces: \$\{\{ steps\.classify\.outputs\.web_workspaces \}\}/u,
    );
    for (const [name, flags] of [
      ["lint", "lint --profile complete"],
      ["typecheck", "typecheck --profile complete"],
      ["test", "test --ci-milestone"],
      ["build", "build --profile complete"],
    ]) {
      const body = jobs.get(name);
      assert.match(body, /needs: classify_e2e/u);
      assert.match(body, /if: needs\.classify_e2e\.outputs\.web == 'true'/u);
      assert.match(
        body,
        /MOYA_VERIFY_WORKSPACES: \$\{\{ needs\.classify_e2e\.outputs\.web_workspaces \}\}/u,
      );
      assert.ok(body.includes(`run: node scripts/verify.mjs ${flags}\n`));
      assert.doesNotMatch(body, /run:.*\$\{\{.*web_workspaces/u);
    }
    for (const name of ["contracts", "cms", "e2e_smoke", "e2e-shards"])
      assert.doesNotMatch(jobs.get(name), /MOYA_VERIFY_WORKSPACES/u);
    const classifier = readFileSync(
      new URL("./ci-task-scope.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      classifier,
      /web_workspaces=\$\{\(plan\.webWorkspaces \?\? \[\]\)\.join\(","\)\}/u,
    );
  });

  it("loads current JS names and fails closed on unknown manifests or filters", (t) => {
    const root = workspaceFixture(t);
    assert.deepEqual(verificationWorkspaces(root), [
      "@moya/backend-runtime",
      "@moya/contracts",
      "@moya/tests",
      "admin",
      "web",
    ]);
    for (const value of ["web...", "web,missing", "web,web", "web,", "*"])
      assert.throws(() =>
        verificationPlan("all", ["--workspaces", value], {}, root),
      );
    assert.throws(() => verificationPlan("all", ["--workspaces"], {}, root));
    assert.throws(() =>
      verificationPlan("e2e", ["--workspaces", "web"], {}, root),
    );
    assert.throws(() =>
      verificationPlan(
        "all",
        ["--workspaces", "web", "--workspaces", "admin"],
        {},
        root,
      ),
    );
    mkdirSync(join(root, "services/unexpected"));
    assert.throws(() => verificationWorkspaces(root), { code: "ENOENT" });
  });

  it("keeps the original stage profile and exact task coverage with selected consumers", (t) => {
    const root = workspaceFixture(t);
    const plan = verificationPlan(
      "all",
      [
        "--profile",
        "complete",
        "--workspaces",
        "web,@moya/tests,@moya/contracts",
      ],
      {},
      root,
    );
    assert.equal(
      plan.ceilingMs,
      verificationPlan("all", ["--profile", "complete"]).ceilingMs,
    );
    const commands = verificationCommands(plan);
    assert.deepEqual(commands[0], ["pnpm", "format:check"]);
    assert.deepEqual(commands[1], [
      "pnpm",
      "exec",
      "turbo",
      "run",
      "lint",
      "typecheck",
      "test",
      "build",
      "--filter=@moya/contracts",
      "--filter=@moya/tests",
      "--filter=web",
    ]);
    assert.ok(commands.at(-1).includes("scripts/ci-e2e-smoke.mjs"));
    assert.ok(commands.at(-1).includes("cold"));
    assert.ok(!commands.flat().includes("--exclude"));
    assert.deepEqual(verificationCommands(verificationPlan("test")), [
      ["pnpm", "test"],
    ]);
    const selectedTest = verificationPlan(
      "test",
      ["--workspaces", "@moya/tests"],
      {},
      root,
    );
    assert.deepEqual(verificationCommands(selectedTest), [
      ["pnpm", "test:confidentiality"],
      ["pnpm", "exec", "turbo", "run", "test", "--filter=@moya/tests"],
    ]);
  });

  it("keeps PostgreSQL preparation uncached and only library builds use their cache", () => {
    const commands = verificationCommands(verificationPlan("test"), {
      TEST_DATABASE_URL: "synthetic-target-present",
    });
    assert.deepEqual(commands[0].slice(-2), [
      "--cache-dir",
      ".turbo/library-cache",
    ]);
    assert.deepEqual(
      commands.slice(1).map((command) => command.slice(1)),
      [
        ["scripts/test-target.mjs", "check", "TEST_DATABASE_URL"],
        ["db:migrate"],
        ["test:postgres"],
        ["test"],
      ],
    );
  });
});

describe("bounded independent checks", () => {
  it("defaults to serial work and treats unselected checks as barriers", async (t) => {
    const directory = temporary(t);
    for (const [offset, options] of [
      [0, {}],
      [3, { parallelIndices: [0, 2] }],
    ]) {
      const result = await runWithinBudget(
        [
          worker(directory, offset),
          worker(directory, offset + 1),
          worker(directory, offset + 2),
        ],
        { budgetMs: 3000, graceMs: 100, stdio: "ignore", ...options },
      );
      assert.equal(result.code, 0);
      assert.deepEqual(
        result.executed.map((record) => record.index),
        [0, 1, 2],
      );
      for (const id of [offset, offset + 1])
        assert.ok(
          timestamp(directory, id, "end") <=
            timestamp(directory, id + 1, "start"),
        );
    }
  });

  it("runs only two adjacent independent commands and waits at the next barrier", async (t) => {
    const directory = temporary(t);
    const result = await runWithinBudget(
      Array.from({ length: 4 }, (_, index) => worker(directory, index, 200)),
      {
        budgetMs: 3000,
        graceMs: 100,
        stdio: "ignore",
        parallelIndices: [0, 1, 2, 3],
      },
    );
    assert.equal(result.code, 0);
    assert.ok(
      timestamp(directory, 0, "start") < timestamp(directory, 1, "end"),
    );
    assert.ok(
      timestamp(directory, 1, "start") < timestamp(directory, 0, "end"),
    );
    for (const first of [0, 1])
      for (const second of [2, 3])
        assert.ok(
          timestamp(directory, first, "end") <=
            timestamp(directory, second, "start"),
        );
    assert.deepEqual(
      result.executed.map((record) => record.index),
      [0, 1, 2, 3],
    );
    await assert.rejects(
      runWithinBudget([worker(directory, 4)], { parallelIndices: [0, 0] }),
    );
    await assert.rejects(
      runWithinBudget([worker(directory, 4)], { parallelIndices: [1] }),
    );
  });

  it("a failed pair cleans its owned sibling and leaves unrelated work alive", async (t) => {
    const directory = temporary(t);
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    t.after(() => stopProcess(unrelated));
    const ready = join(directory, "ready");
    const cleaned = join(directory, "cleaned");
    const result = await runWithinBudget(
      [
        [process.execPath, "-e", "setTimeout(()=>process.exit(7),150)"],
        [
          process.execPath,
          "-e",
          "const fs=require('node:fs');process.on('SIGINT',()=>setTimeout(()=>{fs.writeFileSync(process.argv[2],'done');process.exit(0)},50));fs.writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000);",
          ready,
          cleaned,
        ],
        worker(directory, "must-not-run"),
      ],
      {
        budgetMs: 3000,
        graceMs: 200,
        stdio: "ignore",
        parallelIndices: [0, 1],
      },
    );
    assert.equal(result.code, 7);
    assert.deepEqual(
      result.executed.map((record) => record.index),
      [0, 1],
    );
    assert.ok(existsSync(ready));
    assert.ok(existsSync(cleaned));
    assert.ok(!existsSync(join(directory, "must-not-run.start")));
    assert.ok(alive(unrelated.pid));
  });

  it("a parallel timeout kills only owned detached descendants under the same deadline", async (t) => {
    const directory = temporary(t);
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    t.after(() => stopProcess(unrelated));
    const descendant = "process.on('SIGINT',()=>{});setInterval(()=>{},1000);";
    const parent = `const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));process.on('SIGINT',()=>{});setInterval(()=>{},1000);`;
    const started = Date.now();
    const result = await runWithinBudget(
      [
        [process.execPath, "-e", parent, join(directory, "first.pid")],
        [process.execPath, "-e", parent, join(directory, "second.pid")],
        worker(directory, "after"),
      ],
      { budgetMs: 900, graceMs: 200, stdio: "ignore", parallelIndices: [0, 1] },
    );
    assert.equal(result.code, 124);
    assert.ok(Date.now() - started < 2000);
    assert.equal(result.executed.length, 2);
    assert.ok(!existsSync(join(directory, "after.start")));
    await delay(150);
    for (const name of ["first", "second"])
      assert.ok(
        !alive(Number(readFileSync(join(directory, `${name}.pid`), "utf8"))),
      );
    assert.ok(alive(unrelated.pid));
  });

  it("repeated cancellation grants one cleanup grace to both children", async (t) => {
    const directory = temporary(t);
    const childCode =
      "const fs=require('node:fs');process.on('SIGINT',()=>setTimeout(()=>{fs.writeFileSync(process.argv[1]+'.cleaned','done');process.exit(0)},100));fs.writeFileSync(process.argv[1]+'.ready','ready');setInterval(()=>{},1000);";
    const moduleUrl = new URL("./verify.mjs", import.meta.url).href;
    const files = [join(directory, "one"), join(directory, "two")];
    const driver = `import {runWithinBudget} from ${JSON.stringify(moduleUrl)};const commands=${JSON.stringify(files)}.map(file=>[process.execPath,'-e',${JSON.stringify(childCode)},file]);const r=await runWithinBudget(commands,{budgetMs:3000,graceMs:500,stdio:'ignore',parallelIndices:[0,1]});process.exitCode=r.code;`;
    const wrapper = spawn(
      process.execPath,
      ["--input-type=module", "-e", driver],
      { stdio: "ignore" },
    );
    t.after(() => wrapper.kill("SIGKILL"));
    const exited = new Promise((accept) =>
      wrapper.once("exit", (code) => accept(code)),
    );
    await Promise.all(files.map((file) => waitFor(file + ".ready")));
    const started = Date.now();
    wrapper.kill("SIGTERM");
    await delay(40);
    wrapper.kill("SIGTERM");
    assert.equal(await exited, 130);
    assert.ok(Date.now() - started < 1500);
    assert.ok(files.every((file) => existsSync(file + ".cleaned")));
  });
});
