/**
 * Claude Code PreToolUse guard for Bash commands — a small convenience layer.
 *
 * The permission rules in .claude/settings.json decide first. Routine commits
 * and task-branch pushes go through the fixed operations of
 * scripts/task-git.mjs; raw `git commit` and `git push` are never allowed
 * automatically, so they reach the native prompt unless a deny rule refuses
 * them. This hook turns two prompt-level shapes into outright denials, looking
 * at how a program is invoked rather than at quoted text, search patterns or
 * printed examples:
 *
 * 1. a PostgreSQL client (`psql`, `pgcli`) pointed at the live Development
 *    database `yoyi_dev` with destructive SQL on its command line;
 * 2. `git` run with leading `-C`/`-c` options before `push` together with a
 *    force, prune, mirror or main-branch argument.
 *
 * Nothing depends on it: if the hook cannot start, the command stays with the
 * native rules. It never allows anything, is not a sandbox and does not claim
 * to cover every spelling.
 *
 * Input: the hook JSON on stdin ({ tool_name, tool_input: { command } }).
 * Output: a PreToolUse deny decision on stdout, or nothing.
 */
import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Longer input is left to the native rules; it keeps the matching bounded.
const MAX_COMMAND_LENGTH = 16 * 1024;

const rules = [
  [
    // The program must start a command (string start, a new line or after
    // `;`, `&`, `|`), so the same words inside an echo, grep or printf
    // argument never match. A program inside `$( )` or backticks is not
    // matched here; it falls to the normal permission prompt instead.
    /(?:^|[;&|\n]\s*)(?:\/opt\/homebrew\/bin\/mise\s+exec\s+--\s+)?(?:psql|pgcli)\b[^|;&\n]*\byoyi_dev\b[^|;&\n]*\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/iu,
    "yoyi_dev is the live Development database; never run destructive SQL against it",
  ],
  [
    /(?:^|[;&|\n]\s*)(?:\/opt\/homebrew\/bin\/mise\s+exec\s+--\s+)?git\s+(?:-[Cc]\s+\S+\s+)+push\b[^|;&\n]*(?:--force(?:-with-lease)?\b|\s-f\b|\s\+\S|--prune\b|--mirror\b|\s\S*:(?:refs\/heads\/)?main(?:\s|$)|\s(?:origin\s+)?(?:main|refs\/heads\/main)(?:\s|$))/u,
    "force push or direct push to main is prohibited in every spelling",
  ],
];

export function guardDecision(command) {
  if (
    typeof command !== "string" ||
    command.trim() === "" ||
    command.length > MAX_COMMAND_LENGTH
  )
    return null;
  for (const [pattern, reason] of rules) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

export function hookOutput(input) {
  const command =
    input?.tool_name === "Bash" ? input?.tool_input?.command : undefined;
  const reason = guardDecision(command);
  if (reason === null || reason === undefined) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `yoyi guard: ${reason}. Ask the Owner for the exact operation instead.`,
    },
  };
}

function invokedDirectly() {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) ===
        realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    raw += chunk;
  });
  process.stdin.on("end", () => {
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      // Unreadable input: no decision, normal permission flow applies.
      process.exit(0);
    }
    const output = hookOutput(input);
    if (output) process.stdout.write(JSON.stringify(output));
    process.exit(0);
  });
}
