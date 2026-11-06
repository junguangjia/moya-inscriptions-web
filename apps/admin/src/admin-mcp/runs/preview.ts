import {
  ADMIN_PREVIEW_CONSEQUENCE_CODES,
  ADMIN_PREVIEW_ROWS_MAX,
  ADMIN_PREVIEW_SAMPLE_MAX,
  adminPreviewDataSchema,
  previewCallKind,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminMcpEnvelope,
  AdminOpName,
  AdminPreviewInput,
  AiSelectItem,
} from "@moya/contracts/internal/admin-mcp";
import type { PayloadRequest } from "payload";

import { CommunityOperatorError } from "../../community/backend";
import { controlFor } from "../control/state";
import type { AdminMcpKey } from "../door";
import {
  failedEnvelope,
  inputInvalidEnvelope,
  issuesOfError,
  okEnvelope,
} from "../envelope";
import { communityRefusal } from "../ops/community-reads";
import { safeRef } from "../ops/target";
import { targetFailureOf } from "../refusal";
import { adminOpMeta, isAdminOpName, lookupOp } from "../registry";
import type { AdminOpContext, AdminOpEntry } from "../registry";
import { unsafeInputOf } from "../tools/execute";
import {
  opRefusalOf,
  retiredOpEnvelope,
  unknownOpEnvelope,
  withDeprecation,
  wrongToolEnvelope,
} from "../tools/read";
import { fingerprintOf } from "./hash";
import { runCredentialOf } from "./keys";
import {
  appendChunk,
  createRun,
  findRun,
  readPreviewFacts,
  readRun,
  recordPreview,
} from "./ledger";
import type { LedgerRead, LedgerRefusal, NewTarget } from "./ledger";
import { ABSENT_STAMP, NO_STAMP, stampsOf, withheldCode } from "./sources";

/**
 * admin_preview with explicit targets (admin-mcp-completion-v1 section 8, S8 plan 2.4
 * and 2.5). Each target is checked against its op's input and classed, its record's
 * state is read and frozen beside its input, and what the op's hooks say of it is kept
 * on its row, so the answer sums rows and never reads a frozen input back. A chunk
 * lands whole with its stamps, or not at all. Nothing runs here, and nothing a preview
 * shows is a record's content.
 */

export interface PreviewContext {
  readonly key: AdminMcpKey;
  readonly req: PayloadRequest;
  /** This credential's tools: an irreversible run on a key without its tool never runs. */
  readonly tools: readonly string[];
}

const IRREVERSIBLE_TOOL = "admin_execute_irreversible";
const RUNS_ON: ReadonlySet<string> = new Set([
  "admin_execute",
  IRREVERSIBLE_TOOL,
]);

/** Fixed English, so a hint never carries a caller's text. */
const TOOL_NOT_LISTED =
  "This write is irreversible here, and admin_execute_irreversible is not on this credential, so it could never run: no run was written.";
const WAITING =
  "Waiting for the rest of the targets, so nothing is sealed and nothing runs: send them with this previewId and requestId as appendTargets under chunkSeq";
const SEALED_IRREVERSIBLE =
  "Sealed. Run it with admin_execute_irreversible {requestId, previewId}; past the Owner's threshold it waits for one confirmation on the control page first.";

const toolNotListed = (): AdminMcpEnvelope => ({
  ...failedEnvelope("NOT_AVAILABLE", {
    data: { tool: IRREVERSIBLE_TOOL, unavailable: "tool_not_listed" },
  }),
  hint: TOOL_NOT_LISTED,
});

const refusalEnvelope = ({ code, issues }: LedgerRefusal): AdminMcpEnvelope =>
  failedEnvelope(
    code,
    issues === undefined
      ? {}
      : {
          issues: issues.map(({ path, code: issue }) => ({
            path: [...path],
            code: issue,
          })),
        },
  );

/** By code point, as the preview's schema counts it. */
const shortened = (value: string) => Array.from(value).slice(0, 500).join("");

type Hooks = NonNullable<AdminOpEntry["previewHooks"]>;

/** What a target's preview keeps on its row: content-free, but for identities it binds. */
const factsOf = async (
  hooks: Hooks | undefined,
  command: Readonly<Record<string, unknown>>,
  item: AiSelectItem | undefined,
  context: AdminOpContext,
): Promise<Record<string, unknown>> => {
  if (hooks === undefined) return {};
  const consequences = [...new Set(hooks.consequences(command, item))];
  const impact = hooks.impact?.(command, item) ?? {};
  const identities = (await hooks.newIdentities?.(command, context)) ?? [];
  return {
    ...(hooks.notifiesSubject?.(command) === true ? { notifies: true } : {}),
    ...(consequences.length > 0 ? { consequences } : {}),
    ...(Object.keys(impact).length > 0 ? { impact } : {}),
    ...(identities.length > 0
      ? {
          newIdentities: identities.map(({ field, value }) => ({
            field,
            value: shortened(value),
          })),
        }
      : {}),
  };
};

interface Prepared {
  readonly klass: "reversible" | "irreversible";
  readonly targets: readonly NewTarget[];
}

const targetOf = (entry: AdminOpEntry, command: unknown) => {
  try {
    return entry.target?.(command);
  } catch {
    return undefined;
  }
};

/**
 * One chunk, checked whole before anything is written: a slip in one target refuses
 * it, so a count never holds a target that cannot run. Classed as admin_execute would
 * class each target; one irreversible target makes the whole run irreversible.
 */
const prepareChunk = async (
  entry: AdminOpEntry,
  common: Readonly<Record<string, unknown>>,
  sent: readonly Readonly<Record<string, unknown>>[],
  field: "targets" | "appendTargets",
  { key, req }: PreviewContext,
): Promise<Prepared | AdminMcpEnvelope> => {
  const merged = sent.map((target) => ({ ...common, ...target }));
  const named = new Set<string>();
  const issues = merged.flatMap((command, index) => {
    const parsed = entry.input?.safeParse(command);
    return parsed === undefined || parsed.success
      ? []
      : issuesOfError(parsed.error, entry.input, [field, String(index)], named);
  });
  if (issues.length > 0) return inputInvalidEnvelope(issues);
  // One context a target, so a save's class and its hooks read one state of it.
  const contexts = merged.map((): AdminOpContext => ({ req, key }));
  let klass: Prepared["klass"] =
    entry.klass === "irreversible" ? "irreversible" : "reversible";
  const refused: { path: (string | number)[]; code: string }[] = [];
  for (const [index, command] of merged.entries())
    try {
      if (
        ((await entry.classify?.(command, contexts[index]!)) ?? entry.klass) ===
        "irreversible"
      )
        klass = "irreversible";
    } catch (error) {
      refused.push({ path: [field, index], code: targetFailureOf(error).code });
    }
  if (refused.length > 0) return inputInvalidEnvelope(refused);

  const hooks = entry.previewHooks;
  const source = hooks?.stampSource ?? "none";
  const targets = merged.map((command) => targetOf(entry, command));
  const items =
    source === "none"
      ? undefined
      : await stampsOf(
          source,
          targets.flatMap((target) =>
            target?.id === undefined ? [] : [target.id],
          ),
        );
  const prepared: NewTarget[] = [];
  for (const [index, command] of merged.entries()) {
    const target = targets[index];
    const id = safeRef(target?.id);
    const ref = id === undefined ? {} : { id };
    const refKey =
      target?.id === undefined
        ? `input:${fingerprintOf(command)}`
        : `${target.type}:${target.id}`;
    const item = target?.id === undefined ? undefined : items?.get(target.id);
    const withheld = items === undefined ? undefined : withheldCode(item);
    if (withheld !== undefined) {
      // Frozen too, so it is listed, and never run nor counted.
      prepared.push({
        ref,
        refKey,
        frozenInput: sent[index]!,
        stamp: item?.stamp ?? ABSENT_STAMP,
        state: "conflict",
        code: withheld,
      });
      continue;
    }
    const filled =
      item !== undefined && hooks?.fillFromStamp !== undefined
        ? hooks.fillFromStamp(command, item)
        : command;
    if (filled === "conflict") {
      prepared.push({
        ref,
        refKey,
        frozenInput: sent[index]!,
        stamp: item!.stamp,
        state: "conflict",
        code: "STATE_CONFLICT",
      });
      continue;
    }
    const facts = await factsOf(
      hooks,
      filled as Record<string, unknown>,
      item,
      contexts[index]!,
    );
    prepared.push({
      ref: {
        ...ref,
        ...(item?.state === undefined ? {} : { state: item.state }),
        ...facts,
      },
      refKey,
      // A filled input is frozen whole: merged under it, the common input is the same.
      frozenInput:
        filled === command ? sent[index]! : (filled as Record<string, unknown>),
      stamp: item?.stamp ?? NO_STAMP,
    });
  }
  return { klass, targets: prepared };
};

/** By the order the contract names them, so an answer reads the same each time. */
const inContractOrder = (codes: readonly string[]) =>
  ADMIN_PREVIEW_CONSEQUENCE_CODES.filter((code) => codes.includes(code));

/** The run as it stands, as a preview shows it; a run that ended answers why. */
const answerOf = async (
  { run, stale }: LedgerRead,
  replayed: boolean,
  entry: AdminOpEntry,
  { req }: PreviewContext,
): Promise<AdminMcpEnvelope> => {
  if (run.state === "expired")
    return failedEnvelope(stale ? "PREVIEW_STALE" : "PREVIEW_EXPIRED", {
      runId: run.runId,
    });
  if (run.state === "cancelled")
    return failedEnvelope("RUN_CANCELLED", { runId: run.runId });
  const facts = await readPreviewFacts(req.payload, run.runId, {
    sample: ADMIN_PREVIEW_SAMPLE_MAX,
    rows: ADMIN_PREVIEW_ROWS_MAX,
  });
  const { threshold } = await controlFor(req);
  const count = run.targetCount - facts.conflicts.count;
  const sealed = run.sealedAt !== null;
  const impact =
    Object.keys(facts.impact).length > 0 ? facts.impact : undefined;
  const data = adminPreviewDataSchema.parse({
    previewId: run.runId,
    op: run.op,
    class: run.klass,
    count,
    sample: facts.sample.map(({ index, ref }) => ({
      index,
      ...(ref.id === undefined ? {} : { ref: ref.id }),
      ...(typeof ref.state === "string" ? { state: ref.state } : {}),
    })),
    conflicts: {
      count: facts.conflicts.count,
      rows: facts.conflicts.rows.map(({ index, ref, code }) => ({
        index,
        ...(ref.id === undefined ? {} : { ref: ref.id }),
        code,
      })),
    },
    ...(impact === undefined ? {} : { impact }),
    consequences: inContractOrder(facts.consequences),
    userNotifications: facts.notified,
    ...(facts.newIdentities.count === 0
      ? {}
      : { newIdentities: facts.newIdentities }),
    needsOwnerConfirmation: run.klass === "irreversible" && count > threshold,
    threshold,
    expiresAt: run.expiresAt.toISOString(),
    sealed,
  });
  if (sealed && run.preview === null)
    try {
      await recordPreview(req.payload, run.runId, data, impact);
    } catch {
      // The control page reads it; this answer stands without it.
      req.payload.logger.error({ category: "ADMIN_MCP_PREVIEW_RECORD_FAILED" });
    }
  const meta = {
    ...(replayed ? { replayed: true as const } : {}),
    // Named whatever the run holds, so the name says nothing of any one target.
    ...((entry.previewHooks?.stampSource ?? "none") === "none"
      ? {}
      : { excluded: ["self_only"] }),
  };
  if (!sealed) {
    const answer = failedEnvelope("IN_PROGRESS", {
      data,
      runId: run.runId,
      state: run.state,
      done: run.targetCount,
      ...(run.expectedCount === null
        ? {}
        : {
            total: run.expectedCount,
            remaining: run.expectedCount - run.targetCount,
          }),
    });
    // The same call again cannot move it: only the next chunk can.
    delete answer.retryable;
    return {
      ...answer,
      hint: `${WAITING} ${run.lastChunkSeq + 1}.`,
      meta,
    };
  }
  const answer = {
    ...okEnvelope(data),
    runId: run.runId,
    state: run.state,
    meta,
  };
  // Running an irreversible run is a call of its own, never a way on from here.
  return run.klass === "irreversible"
    ? { ...answer, hint: SEALED_IRREVERSIBLE }
    : {
        ...answer,
        next: {
          tool: "admin_execute",
          args: { requestId: run.requestId, previewId: run.runId },
        },
      };
};

const sentOf = ({
  op,
  input,
  targets,
  selector,
  expectedCount,
}: AdminPreviewInput) => ({ op, input, targets, selector, expectedCount });

const reasonOf = (input: Readonly<Record<string, unknown>> | undefined) =>
  typeof input?.reason === "string" ? input.reason : undefined;

const createOf = async (
  name: AdminOpName,
  call: AdminPreviewInput,
  context: PreviewContext,
): Promise<AdminMcpEnvelope> => {
  const { key, req, tools } = context;
  const entry: AdminOpEntry = adminOpMeta[name];
  // A read is never planned: class decides the tool, and a run holds writes.
  if (!RUNS_ON.has(entry.tool)) return wrongToolEnvelope(entry.tool);
  const refusal = await opRefusalOf(entry, req);
  if (refusal !== undefined) return refusal;
  if (entry.tool === IRREVERSIBLE_TOOL && !tools.includes(IRREVERSIBLE_TOOL))
    return toolNotListed();
  // A selector and a run's own targets plan through the selector, which is S8-14's.
  if (call.selector !== undefined) return failedEnvelope("NOT_AVAILABLE");
  const unsafe =
    unsafeInputOf(call.input, ["input"]) ??
    unsafeInputOf(call.targets, ["targets"]);
  if (unsafe !== undefined) return inputInvalidEnvelope([unsafe]);
  const credential = runCredentialOf(key);
  const sent = sentOf(call);
  // Before any of the work a new run takes: the same call again answers its run.
  const earlier = await findRun(
    req.payload,
    credential.credential,
    call.requestId,
    sent,
  );
  if (earlier !== undefined)
    return earlier.ok
      ? answerOf(earlier, true, entry, context)
      : refusalEnvelope(earlier);
  const prepared = await prepareChunk(
    entry,
    call.input ?? {},
    call.targets!,
    "targets",
    context,
  );
  if (!("targets" in prepared)) return prepared;
  if (prepared.klass === "irreversible" && !tools.includes(IRREVERSIBLE_TOOL))
    return toolNotListed();
  const created = await createRun(
    req.payload,
    {
      credential,
      userId: Number(key.user.id),
      op: name,
      klass: prepared.klass,
      requestId: call.requestId,
      sent,
      ...(reasonOf(call.input) === undefined
        ? {}
        : { reason: reasonOf(call.input)! }),
      ...(call.input === undefined ? {} : { commonInput: call.input }),
      selection: { kind: "targets" },
      expectedCount: call.expectedCount ?? call.targets!.length,
    },
    prepared.targets,
  );
  return created.ok
    ? answerOf(created, created.replayed, entry, context)
    : refusalEnvelope(created);
};

/** A later planning call: the next chunk of targets, or the next block of a selector. */
const planOf = async (
  call: AdminPreviewInput,
  context: PreviewContext,
): Promise<AdminMcpEnvelope> => {
  const { key, req, tools } = context;
  const credential = runCredentialOf(key).credential;
  const read = await readRun(req.payload, credential, call.previewId!);
  if (read === undefined) return failedEnvelope("NOT_FOUND");
  const { run } = read;
  // An op this release no longer holds left the run stale, and reading it expired it.
  if (!isAdminOpName(run.op))
    return failedEnvelope("PREVIEW_STALE", { runId: run.runId });
  const entry: AdminOpEntry = adminOpMeta[run.op];
  const sent =
    call.appendTargets === undefined
      ? { continuePlanning: true }
      : { appendTargets: call.appendTargets };
  const chunk = {
    credential,
    runId: run.runId,
    requestId: call.requestId,
    chunkSeq: call.chunkSeq!,
    sent,
  };
  // Anything but the next number of a planning run of this requestId, the ledger answers
  // as itself, and writes nothing: a replay, a conflict, a refusal or an ended run.
  if (
    call.chunkSeq !== run.lastChunkSeq + 1 ||
    run.state !== "planning" ||
    run.requestId !== call.requestId
  ) {
    const answered = await appendChunk(req.payload, { ...chunk, targets: [] });
    return answered.ok
      ? answerOf(answered, answered.replayed, entry, context)
      : refusalEnvelope(answered);
  }
  // A selector's planning goes on by this, and none is planned until S8-14.
  if (call.appendTargets === undefined)
    return inputInvalidEnvelope([
      { path: ["continuePlanning"], code: "no_selector" },
    ]);
  const refusal = await opRefusalOf(entry, req);
  if (refusal !== undefined) return refusal;
  const unsafe = unsafeInputOf(call.appendTargets, ["appendTargets"]);
  if (unsafe !== undefined) return inputInvalidEnvelope([unsafe]);
  const prepared = await prepareChunk(
    entry,
    run.commonInput ?? {},
    call.appendTargets,
    "appendTargets",
    context,
  );
  if (!("targets" in prepared)) return prepared;
  if (
    (prepared.klass === "irreversible" || run.klass === "irreversible") &&
    !tools.includes(IRREVERSIBLE_TOOL)
  )
    return toolNotListed();
  const planned = await appendChunk(req.payload, {
    ...chunk,
    targets: prepared.targets,
    klass: prepared.klass,
  });
  return planned.ok
    ? answerOf(planned, planned.replayed, entry, context)
    : refusalEnvelope(planned);
};

const runPreview = async (
  call: AdminPreviewInput,
  context: PreviewContext,
): Promise<AdminMcpEnvelope> => {
  if (previewCallKind(call) !== "create") return planOf(call, context);
  const found = lookupOp(call.op!);
  if ("unknown" in found) return unknownOpEnvelope(call.op!);
  if ("retired" in found) return retiredOpEnvelope(found.retired);
  return withDeprecation(
    await createOf(found.op, call, context),
    found.deprecated === undefined ? [] : [found.deprecated],
  );
};

/** A stamp read the Backend refused says so by name; nothing was written then. */
export const previewEnvelope = async (
  rawInput: unknown,
  context: PreviewContext,
): Promise<AdminMcpEnvelope> => {
  try {
    return await runPreview(rawInput as AdminPreviewInput, context);
  } catch (error) {
    if (error instanceof CommunityOperatorError) return communityRefusal(error);
    throw error;
  }
};
