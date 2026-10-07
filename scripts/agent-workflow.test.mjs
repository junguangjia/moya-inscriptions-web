import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import { URL, fileURLToPath } from "node:url";
import { guardDecision, hookOutput } from "../.claude/hooks/guard-bash.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) =>
  readFileSync(new URL(file, new URL("../", import.meta.url)), "utf8");
const frontmatter = (text) => {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(text);
  assert.ok(match, "SKILL.md needs YAML frontmatter");
  return Object.fromEntries(
    match[1]
      .split("\n")
      .filter((line) => /^[a-z-]+:/u.test(line))
      .map((line) => {
        const index = line.indexOf(":");
        return [line.slice(0, index), line.slice(index + 1).trim()];
      }),
  );
};
const skills = ["yoyi-task", "yoyi-review", "yoyi-handoff"];

describe("one canonical skill body per skill, one adapter per tool", () => {
  it("Codex bodies exist, name themselves correctly and describe their invocation", () => {
    for (const name of skills) {
      const body = read(`.agents/skills/${name}/SKILL.md`);
      const meta = frontmatter(body);
      assert.equal(meta.name, name);
      assert.ok(meta.description !== undefined, `${name} description`);
      assert.match(body, /## Invocation/u);
      assert.ok(
        body.includes(`$${name}`),
        `${name} names its Codex invocation`,
      );
      assert.ok(
        body.includes(`/${name}`),
        `${name} names its Claude invocation`,
      );
      assert.doesNotMatch(
        body,
        /\/Users\/[a-z]+\//u,
        "no absolute personal paths",
      );
    }
  });

  it("the bodies carry the closeout clarifications", () => {
    const task = read(".agents/skills/yoyi-task/SKILL.md").replace(
      /\s+/gu,
      " ",
    );
    assert.match(task, /## Instruction context and freshness/u);
    assert.match(task, /same unchanged task context, reuse/u);
    assert.match(
      task,
      /do not reread the governance set unless the rule files changed/u,
    );
    assert.match(task, /never marks its own PR Ready or merges it/u);
    assert.match(task, /node scripts\/task-git\.mjs push/u);
    assert.match(task, /never retry with raw `git commit` or `git push`/u);
    assert.match(task, /never new Owner authority/u);
    assert.doesNotMatch(task, /by default a Draft PR/u);
    const workflow = read("docs/development/task-workflow.md").replace(
      /\s+/gu,
      " ",
    );
    assert.match(workflow, /## Production and cloud tools: two gates/u);
    assert.match(
      workflow,
      /An approval prompt confirms that concrete tool call only/u,
    );
    assert.match(
      workflow,
      /do not fall back to raw `git commit` or `git push`/u,
    );
    const review = read(".agents/skills/yoyi-review/SKILL.md").replace(
      /\s+/gu,
      " ",
    );
    assert.match(review, /## Delivery after review/u);
    assert.match(
      review,
      /gh pr merge <n> --squash --match-head-commit <reviewed sha>/u,
    );
    assert.match(review, /Task limited to Draft/u);
    assert.match(
      review,
      /Production, remote settings or destructive operations/u,
    );
    const handoff = read(".agents/skills/yoyi-handoff/SKILL.md").replace(
      /\s+/gu,
      " ",
    );
    assert.match(handoff, /Readers are not writers/u);
    assert.match(handoff, /open file or process id alone is not proof/u);
    assert.match(handoff, /unpushed local commit is recorded and reconciled/u);
    assert.doesNotMatch(handoff, /no process has the worktree open/u);
  });

  it("Claude adapters render the canonical body instead of duplicating it", () => {
    for (const name of skills) {
      const adapter = read(`.claude/skills/${name}/SKILL.md`);
      const meta = frontmatter(adapter);
      assert.equal(meta.name, name);
      assert.equal(
        meta["disable-model-invocation"],
        "true",
        `${name}: skills with side effects are user-invoked`,
      );
      assert.ok(meta["argument-hint"], `${name} argument hint`);
      const injected =
        /!`cat "\$\{CLAUDE_SKILL_DIR:-\.claude\/skills\/([a-z-]+)\}\/\.\.\/\.\.\/\.\.\/\.agents\/skills\/([a-z-]+)\/SKILL\.md"`/u.exec(
          adapter,
        );
      assert.ok(injected, `${name} injects the canonical body`);
      assert.equal(injected[1], name);
      assert.equal(injected[2], name);
      assert.ok(existsSync(`${root}.agents/skills/${name}/SKILL.md`));
      assert.match(adapter, /\$ARGUMENTS/u);
      assert.match(adapter, /read\s+that file before/u, "fallback instruction");
      assert.doesNotMatch(
        adapter,
        /## Invocation/u,
        "adapter carries no second body",
      );
      assert.ok(adapter.split("\n").length < 30, "adapter stays thin");
    }
  });

  it("no third instruction convention and no duplicate skill directories", () => {
    for (const directory of [".agents/skills", ".claude/skills"]) {
      const names = readdirSync(`${root}${directory}`).filter((entry) =>
        entry.startsWith("yoyi-"),
      );
      assert.deepEqual(
        names.filter((n) => skills.includes(n)).sort(),
        [...skills].sort(),
        directory,
      );
      assert.equal(new Set(names).size, names.length);
    }
    assert.ok(!existsSync(`${root}AGENT.md`));
    assert.ok(!existsSync(`${root}AGENTS.override.md`));
    assert.ok(
      !existsSync(`${root}.codex`),
      "no project-level Codex config duplicating the skills",
    );
    const agents = read("AGENTS.md");
    assert.match(agents, /## Task lifecycle skills/u);
    assert.match(agents, /When entering a task context/u);
    assert.match(agents, /delivery stop\s+is that task's authorization/u);
    // 121 = 120 plus the 2026-10-04 amendment's one registration line, so
    // that no other authority entry is rewritten to fit the cap.
    assert.ok(agents.split("\n").length <= 121, "root instructions stay brief");
  });
});

describe("project-scoped Claude permissions: positive allowlist first, fail closed", () => {
  const settings = JSON.parse(read(".claude/settings.json"));
  const { allow, ask, deny } = settings.permissions;

  it("allows read-only Git/GitHub, the two task Git helper operations, Draft PRs, PR comments and verification entries", () => {
    for (const rule of allow) {
      assert.match(
        rule,
        /^Bash\((?:git (?:status|diff|log|show|rev-parse|branch|worktree (?:list|add)|fetch origin|ls-remote|merge-base|cherry|merge (?:--no-edit )?origin\/main\)|stash (?:list|show)|add)|gh (?:pr (?:view|list|diff|checks|create --draft|comment)|issue (?:view|list|create)|run (?:view|list))|(?:\/opt\/homebrew\/bin\/mise exec -- )?node (?:scripts\/verify(?:-task|-apple)?\.mjs|scripts\/test-target\.mjs check|scripts\/task-git\.mjs (?:commit --message|push\))|scripts\/task-context\.mjs (?:snapshot|verify) --task|scripts\/task-resources\.mjs (?:prepare|inspect) --task|--test scripts\/)|(?:\/opt\/homebrew\/bin\/mise exec -- )?pnpm (?:(?:dev:task:(?:prepare|inspect)|task:(?:snapshot|verify-context)) --task|verify|test:e2e:smoke|format:check|lint|typecheck|install --frozen-lockfile|--filter \* exec vitest run))/u,
        rule,
      );
      assert.doesNotMatch(
        rule,
        /^Bash\(\*?\)$|^Bash\(git (?:commit|push)|Bash\(rm|Bash\(sudo|Bash\(curl|Bash\(ssh|Bash\(scp|Bash\(gh (?:pr (?:merge|ready|review|edit)|issue comment)|cloud|tcb|tccli|coscli/u,
        rule,
      );
    }
    for (const required of [
      "Bash(node scripts/task-git.mjs commit --message-file *)",
      "Bash(node scripts/task-git.mjs commit --message *)",
      "Bash(node scripts/task-git.mjs push)",
      "Bash(gh pr create --draft *)",
      "Bash(gh pr comment *)",
      "Bash(gh issue create *)",
      "Bash(git worktree add *)",
      "Bash(git stash list*)",
    ])
      assert.ok(allow.includes(required), required);
  });

  it("asks (native consent) for delivery, task records, PR edits, cloud tools and state-changing operations", () => {
    for (const required of [
      "Bash(gh pr ready *)",
      "Bash(gh pr merge *)",
      "Bash(gh issue comment *)",
      "Bash(gh pr review *)",
      "Bash(gh pr edit *)",
      "Bash(git push * --delete *)",
      "Bash(git rebase *)",
      "Bash(git reset *)",
      "Bash(git stash pop*)",
      "Bash(rm -rf *)",
      "Bash(pnpm add *)",
      "Bash(docker compose *)",
      "Bash(node scripts/test-target.mjs mark *)",
      "Bash(tcb *)",
      "Bash(tccli *)",
      "Bash(cloudbase *)",
      "Bash(coscli *)",
      "mcp__cloudbase",
    ])
      assert.ok(ask.includes(required), required);
    assert.ok(
      !ask.includes("Bash(gh pr create *)"),
      "an ask rule would override the Draft-PR allow rule (ask beats allow)",
    );
    assert.ok(
      !ask.includes("Bash(git stash *)"),
      "stash inspection must not prompt",
    );
    for (const rule of [...allow, ...ask, ...deny])
      assert.doesNotMatch(
        rule,
        /:\*\)$/u,
        `${rule}: a trailing ":*" is the legacy prefix syntax, not a literal colon`,
      );
    for (const forbidden of [
      "Bash(gh pr merge *)",
      "Bash(gh pr ready *)",
      "Bash(gh pr create *)",
      "Bash(git push *)",
      "Bash(gh issue create *)",
      "Bash(git worktree add *)",
      "Bash(gh ruleset *)",
      "Bash(tcb *)",
      "mcp__cloudbase",
    ])
      assert.ok(
        !deny.includes(forbidden),
        `${forbidden} must not be an unconditional deny`,
      );
  });

  it("denies the leading spellings of force pushes, pushes to main, hook bypasses, history rewrites, worktree removal, repository settings and data deletion", () => {
    for (const required of [
      "Bash(git push *--force*)",
      "Bash(git push -f *)",
      "Bash(git push * -f)",
      "Bash(git push origin main)",
      "Bash(git push * *:main)",
      "Bash(git push *--no-verify*)",
      "Bash(git merge *--no-verify*)",
      "Bash(git commit --no-verify*)",
      "Bash(git commit -n)",
      "Bash(git commit -n *)",
      "Bash(git push * +*)",
      "Bash(git push *--prune*)",
      "Bash(git push *--mirror*)",
      "Bash(git reset --hard*)",
      "Bash(git clean *)",
      "Bash(git worktree remove *)",
      "Bash(git worktree prune *)",
      "Bash(git branch -D *)",
      "Bash(gh repo edit *)",
      "Bash(gh api -X DELETE *)",
      "Bash(gh api *rulesets*)",
      "Bash(docker compose * down -v*)",
      "Bash(docker volume rm *)",
      "Bash(dropdb *)",
      "Read(./.env)",
      "Read(./.env.local)",
      "Read(./.env.*.local)",
      "Read(./**/.env.*.local)",
    ])
      assert.ok(deny.includes(required), required);
    for (const rule of deny.filter((r) => r.startsWith("Bash(git commit")))
      assert.doesNotMatch(
        rule,
        /^Bash\(git commit \*/u,
        `${rule} would match commit-message text`,
      );
    assert.ok(
      !deny.includes("Read(./.env.*)"),
      "the tracked .env.example templates must stay readable",
    );
    assert.equal(settings.permissions.defaultMode, undefined);
    assert.equal(settings.permissions.additionalDirectories, undefined);
    assert.equal(settings.enableAllProjectMcpServers, undefined);
  });

  it("registers exactly one Bash PreToolUse guard and nothing else", () => {
    assert.deepEqual(Object.keys(settings.hooks), ["PreToolUse"]);
    const [entry, ...rest] = settings.hooks.PreToolUse;
    assert.equal(rest.length, 0);
    assert.equal(entry.matcher, "Bash");
    assert.equal(entry.hooks.length, 1);
    assert.equal(entry.hooks[0].type, "command");
    assert.match(
      entry.hooks[0].command,
      /\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/hooks\/guard-bash\.mjs/u,
    );
    assert.ok(entry.hooks[0].timeout <= 30);
  });

  // Documented Bash rule matching (code.claude.com/docs/en/permissions): `*`
  // matches any text including spaces; a trailing ` *` also matches the bare
  // command only when it is the rule's single wildcard; deny, then ask, then
  // allow. Claude Code splits compound commands first, so fixtures are single
  // commands. No hook is consulted: these outcomes must hold without it.
  const ruleMatches = (rule, command) => {
    const pattern = rule.slice("Bash(".length, -1).replace(/[ \t]+/gu, " ");
    let source = pattern
      .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
      .replaceAll("*", ".*");
    if ((pattern.match(/\*/gu) ?? []).length === 1 && source.endsWith(" .*"))
      source = `${source.slice(0, -3)}( .*)?`;
    return new RegExp(`^${source}$`, "su").test(
      command.replace(/[ \t]+/gu, " "),
    );
  };
  const nativeDecision = (command) => {
    for (const [decision, rules] of [
      ["deny", deny],
      ["ask", ask],
      ["allow", allow],
    ])
      if (rules.some((r) => r.startsWith("Bash(") && ruleMatches(r, command)))
        return decision;
    return "prompt";
  };

  it("allows routine commits and pushes only through the helper, whatever the message says", () => {
    for (const command of [
      "node scripts/task-git.mjs commit --message-file /tmp/yoyi-message.txt",
      'node scripts/task-git.mjs commit --message "fix -n handling; forbid --no-verify"',
      "node scripts/task-git.mjs push",
      "gh pr comment --body-file /tmp/yoyi-evidence.md",
      "git merge origin/main",
    ])
      assert.equal(nativeDecision(command), "allow", command);
    for (const [command, expected] of [
      ['git commit -m "docs: explain head -n limits"', "prompt"],
      ["git push -u origin chore/x", "prompt"],
      ["node scripts/task-git.mjs push --force", "prompt"],
      ["gh pr edit 123 --body-file /tmp/body.md", "ask"],
      ["gh issue comment 120 --body-file /tmp/r3.md", "ask"],
      ["gh pr review 123 --comment --body x", "ask"],
      ["gh pr merge 123 --squash", "ask"],
      ["tcb env list", "ask"],
      ["git merge origin/main --no-verify", "deny"],
    ])
      assert.equal(nativeDecision(command), expected, command);
  });

  it("never allows a forbidden git spelling automatically, even when no hook runs", () => {
    for (const command of [
      "git push --force origin chore/x",
      "git push origin chore/x -f",
      "git push -u origin chore/x -f",
      "git push origin chore/x -uf",
      "git push origin +chore/x",
      "git push origin HEAD:main",
      "git push origin :chore/x",
      "git push --mirror origin",
      "git commit -n -m x",
      'git commit -nm "msg"',
      'git commit -anm "msg"',
      "git commit --no-verify -m x",
      "git -c core.hooksPath=/dev/null commit -m x",
    ])
      assert.notEqual(nativeDecision(command), "allow", command);
  });
});

describe("precise mise and task helper permissions", () => {
  it("allows only named existing entries and fixed task helper operations", () => {
    const allow = JSON.parse(read(".claude/settings.json")).permissions.allow;
    for (const rule of allow.filter((r) => r.includes("mise exec"))) {
      assert.match(
        rule,
        /^Bash\(\/opt\/homebrew\/bin\/mise exec -- (?:node (?:scripts\/(?:verify(?:-task|-apple)?|test-target|task-git|task-context|task-resources)\.mjs|--test scripts\/)|pnpm (?:(?:dev:task:(?:prepare|inspect)|task:(?:snapshot|verify-context)) --task|verify|test:e2e:smoke|format:check|lint|typecheck|install --frozen-lockfile|--filter))/u,
      );
    }
    assert.ok(!allow.includes("Bash(/opt/homebrew/bin/mise exec -- *)"));
    for (const op of ["snapshot", "verify"])
      assert.ok(
        allow.includes(
          `Bash(/opt/homebrew/bin/mise exec -- node scripts/task-context.mjs ${op} --task *)`,
        ),
      );
    for (const op of ["prepare", "inspect"])
      assert.ok(
        allow.includes(
          `Bash(/opt/homebrew/bin/mise exec -- node scripts/task-resources.mjs ${op} --task *)`,
        ),
      );
  });
  it("retains narrow guard denials through the canonical runtime wrapper", () => {
    assert.ok(
      guardDecision(
        '/opt/homebrew/bin/mise exec -- psql yoyi_dev -c "TRUNCATE things"',
      ),
    );
    assert.ok(
      guardDecision(
        "/opt/homebrew/bin/mise exec -- git -C /tmp/task push origin main",
      ),
    );
    assert.equal(
      guardDecision(
        "echo /opt/homebrew/bin/mise exec -- psql yoyi_dev TRUNCATE",
      ),
      null,
    );
    assert.equal(
      guardDecision(
        "/opt/homebrew/bin/mise exec -- node scripts/task-git.mjs push",
      ),
      null,
    );
  });
});

describe("the small Bash guard stays a convenience layer", () => {
  const denied = [
    "psql -d yoyi_dev -c 'TRUNCATE community.comments'",
    'psql postgresql://x@127.0.0.1:54330/yoyi_dev -c "DELETE FROM community.public_users"',
    "pgcli -d yoyi_dev -e 'DROP TABLE community.sessions'",
    "git -C ../other push --force origin chore/x",
    "git -c core.hooksPath=/dev/null push origin main",
    "git -C . push origin HEAD:main",
    "git -C . push origin +chore/x",
    "git -C . push origin chore/x:main",
    "git -C . push origin HEAD:refs/heads/main",
    "git -C . push --prune origin",
    "git status\ngit -C . push --force origin chore/x",
    "true; psql -d yoyi_dev -c 'DROP TABLE x'",
  ];
  const harmless = [
    "rg 'DROP DATABASE' docs/",
    "grep -rn 'gh pr merge' .agents/skills",
    "printf '%s\\n' 'gh pr merge 123'",
    "echo \"never run: psql -d yoyi_dev -c 'TRUNCATE x'\" > /dev/null",
    "psql -d yoyi_dev -c 'SELECT count(*) FROM community.comments'",
    "psql -d moya_synthetic_test -c 'TRUNCATE catalog_entries'",
    "node scripts/task-git.mjs push",
    'node scripts/task-git.mjs commit --message "never run git push --force"',
    "git -C ../other push origin chore/x",
    'grep -rn "(psql -d yoyi_dev -c DROP)" docs/',
    "node scripts/test-target.mjs check TEST_DATABASE_URL",
    "",
  ];
  it("denies destructive SQL against yoyi_dev and the -C/-c spelling of a forbidden push", () => {
    for (const command of denied)
      assert.equal(typeof guardDecision(command), "string", command);
  });
  it("never treats searched, quoted or printed command text as execution", () => {
    for (const command of harmless)
      assert.equal(guardDecision(command), null, command);
  });
  it("leaves oversized input to the native rules instead of matching it", () => {
    const started = Date.now();
    assert.equal(
      guardDecision(
        `psql -d postgres -c "${"yoyi_dev ".repeat(200_000)} DROP"`,
      ),
      null,
    );
    assert.ok(Date.now() - started < 1_000);
  });
  it("only shapes a PreToolUse deny for Bash and stays silent otherwise", () => {
    const denial = hookOutput({
      tool_name: "Bash",
      tool_input: { command: "psql -d yoyi_dev -c 'DROP TABLE x'" },
    });
    assert.equal(denial.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(denial.hookSpecificOutput.permissionDecision, "deny");
    assert.match(
      denial.hookSpecificOutput.permissionDecisionReason,
      /yoyi_dev/u,
    );
    assert.equal(
      hookOutput({ tool_name: "Read", tool_input: { file_path: "x" } }),
      null,
    );
    assert.equal(
      hookOutput({ tool_name: "Bash", tool_input: { command: "git status" } }),
      null,
    );
    assert.equal(hookOutput(undefined), null);
  });
  it("runs as a command hook from a real or symlinked path: JSON in, decision out, exit 0", () => {
    const directory = mkdtempSync(join(tmpdir(), "yoyi-guard-"));
    const linked = join(directory, "guard-bash.mjs");
    symlinkSync(join(root, ".claude/hooks/guard-bash.mjs"), linked);
    try {
      for (const script of [".claude/hooks/guard-bash.mjs", linked]) {
        const run = (input) =>
          spawnSync(process.execPath, [script], {
            cwd: root,
            input,
            encoding: "utf8",
            timeout: 10_000,
          });
        const blocked = run(
          JSON.stringify({
            tool_name: "Bash",
            tool_input: { command: "git -C . push --force origin x" },
          }),
        );
        assert.equal(blocked.status, 0, script);
        assert.equal(
          JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision,
          "deny",
          script,
        );
        for (const input of [
          JSON.stringify({
            tool_name: "Bash",
            tool_input: { command: "rg 'DROP DATABASE' docs/" },
          }),
          JSON.stringify({ tool_name: "Read", tool_input: {} }),
          "not json",
          "",
        ]) {
          const quiet = run(input);
          assert.equal(quiet.status, 0, `${script}: ${input}`);
          assert.equal(quiet.stdout, "", `${script}: ${input}`);
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("task records, templates and the Owner guide", () => {
  it("the Issue form captures every lightweight template field once", () => {
    const form = read(".github/ISSUE_TEMPLATE/task.yml");
    for (const id of [
      "task_id",
      "revision",
      "workstream",
      "goal",
      "non_goals",
      "scope",
      "preserved",
      "acceptance",
      "restrictions",
      "responsibility",
      "delivery",
    ]) {
      const occurrences = form.split(`id: ${id}\n`).length - 1;
      assert.equal(occurrences, 1, id);
    }
    assert.match(form, /labels: \["task"\]/u);
    const delivery = form.replace(/\s+/gu, " ");
    assert.doesNotMatch(delivery, /Default stop is a reviewed Draft PR/u);
    assert.match(
      delivery,
      /delivered by independent review, then an expected-head squash merge/u,
    );
    assert.match(delivery, /Write a Draft limit here only when one applies/u);
    assert.match(form, /- Web\n\s+- Apple\n\s+- Shared/u);
    assert.match(
      read(".github/ISSUE_TEMPLATE/config.yml"),
      /^blank_issues_enabled: true\n$/u,
    );
    assert.match(
      read(".github/pull_request_template.md"),
      /Task Issue and specification revision/u,
    );
  });

  it("the Owner quick start uses placeholders, separates Issue from PR numbers and documents dependency-aware rollback", () => {
    const readme = read("README.md").replace(/\s+/gu, " ");
    for (const text of [
      "/yoyi-task plan",
      "$yoyi-task plan",
      "/yoyi-review",
      "$yoyi-review",
      "/yoyi-handoff save",
      "$yoyi-handoff save",
      "Ideas / Ready / Doing / Review / Done",
      "/yoyi-task start #<issue>",
      "/yoyi-review <pr>",
      "Issue #119 / PR #122",
      "Issue #120 / PR #123",
      "git revert",
    ])
      assert.ok(readme.includes(text), text);
    const example = /```text\n([\s\S]*?)```/u.exec(read("README.md"))[1];
    assert.doesNotMatch(
      example,
      /#\d+|review \d+/u,
      "examples use placeholders, not real Issue or PR numbers",
    );
    assert.doesNotMatch(readme, /暂存与未提交改动不受影响/u);
    assert.doesNotMatch(readme, /PreToolUse 钩子立即生效/u);
    assert.doesNotMatch(readme, /合并即生效/u);
    assert.ok(readme.includes(".claude/settings.local.json"));
    assert.ok(readme.includes("Draft PR #124"));
    assert.ok(readme.includes("node scripts/task-git.mjs"));
    assert.ok(readme.includes("/reload-skills"));
    assert.doesNotMatch(readme, /一定先经过钩子检查/u);
    const map = read(
      "docs/governance/history/2026-09-13-workflow-rule-migration-map.md",
    );
    assert.match(
      map,
      /\| MODERNIZE\s+\| Read the full authority when entering a task context/u,
    );
    assert.match(
      map,
      /\| RETIRE\s+\| Native permission rules keep fixed leading spellings; routine commit and push are positive-allowlisted helper operations/u,
    );
    assert.match(
      map,
      /\| "Deny production\/cloud commands" \(Issue #120 criterion 3, r1\)\s+\| MODERNIZE/u,
    );
    assert.doesNotMatch(map, /guard hook denies it inside compound commands/u);
    assert.match(map, /\| Default delivery stop "reviewed Draft PR"/u);
    assert.match(
      map,
      /Readers, idle editors and the incoming session are not writers/u,
    );
  });
});
