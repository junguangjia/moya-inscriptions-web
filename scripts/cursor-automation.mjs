import { createHash } from "node:crypto";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
const id = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
export const AUTOMATION_MARKER = "<!-- cursor-automation-summary:v1 -->";
export const OWNER_MODEL =
  "grok-4.7[context=500k,reasoning_effort=xhigh,fast=true]";
const ledgerStart = "<!-- cursor-automation-ledger:v1 ";

export function automaticEvent(name, event, repository) {
  if (name === "pull_request_target") {
    const pr = event.pull_request;
    const merged = event.action === "closed" && pr?.merged === true;
    if (
      !merged &&
      !["opened", "reopened", "synchronize", "ready_for_review"].includes(
        event.action,
      )
    )
      return null;
    const target = {
      automatic: true,
      kind: merged ? "postmerge" : "review",
      number: pr?.number,
      head: merged ? pr.merge_commit_sha : pr?.head?.sha,
      prHead: pr?.head?.sha,
      baseRef: pr?.base?.ref,
      postMerge: merged,
      event: event.action,
      metadataOnly: merged,
    };
    return automaticPR(pr, repository, target) ? target : null;
  }
  if (name !== "workflow_run") return null;
  const r = event.workflow_run;
  if (
    event.action !== "completed" ||
    r?.name !== "CI" ||
    r.path !== ".github/workflows/ci.yml" ||
    !["pull_request", "workflow_dispatch", "push"].includes(r.event) ||
    r.status !== "completed" ||
    !["success", "failure", "timed_out", "cancelled", "skipped"].includes(
      r.conclusion,
    ) ||
    r.head_repository?.full_name !== repository ||
    !sha(r.head_sha) ||
    !id(r.id) ||
    !id(r.run_attempt)
  )
    return null;
  return {
    automatic: true,
    kind: "ci",
    runId: Number(r.id),
    attempt: Number(r.run_attempt),
    head: r.head_sha,
    event: `CI:${r.event}`,
    conclusion: r.conclusion,
    metadataOnly: !["failure", "timed_out"].includes(r.conclusion),
  };
}

export function automaticPR(pr, repository, target) {
  return Boolean(
    pr &&
    id(pr.number) &&
    sha(pr.head?.sha) &&
    sha(pr.base?.sha) &&
    pr.head.repo?.full_name === repository &&
    pr.base.repo?.full_name === repository &&
    typeof pr.base.ref === "string" &&
    (!target.baseRef || pr.base.ref === target.baseRef) &&
    (!target.base || pr.base.sha === target.base) &&
    (target.postMerge
      ? pr.state === "closed" &&
        pr.merged === true &&
        sha(pr.merge_commit_sha) &&
        pr.merge_commit_sha === target.head &&
        (!target.prHead || pr.head.sha === target.prHead) &&
        pr.base.ref === "main"
      : pr.state === "open" && (!target.head || pr.head.sha === target.head)),
  );
}

export function automaticRun(run, target) {
  return Boolean(
    run &&
    run.id === target.runId &&
    run.run_attempt === target.attempt &&
    run.head_sha === target.head &&
    run.status === "completed" &&
    run.name === "CI" &&
    run.path === ".github/workflows/ci.yml" &&
    run.repository?.full_name === target.repository &&
    run.head_repository?.full_name === target.repository &&
    ["pull_request", "workflow_dispatch", "push"].includes(run.event) &&
    run.conclusion === target.conclusion &&
    (!target.workflowId || run.workflow_id === target.workflowId),
  );
}

export function automaticKey(repository, target) {
  // PR event aliases collapse to one head review. New CI attempts are new
  // evidence, not a second full review. Merge notification and push CI share PR.
  const phase = target.questionDigest
    ? "question"
    : target.runId
      ? "ci"
      : target.postMerge
        ? "merge-notice"
        : "review";
  return hash(
    JSON.stringify([
      repository,
      target.number,
      target.head,
      target.runId ?? null,
      target.attempt ?? null,
      phase,
      target.questionDigest ?? null,
    ]),
  );
}

export function readLedger(comments) {
  const comment = comments.find(
    (c) =>
      c.user?.login === "github-actions[bot]" &&
      c.user.type === "Bot" &&
      c.body?.startsWith(AUTOMATION_MARKER),
  );
  if (!comment) return { comment: null, records: [] };
  const start = comment.body.lastIndexOf(ledgerStart);
  const end = comment.body.indexOf(" -->", start);
  if (start < 0 || end < 0) throw Error("AUTOMATION_LEDGER_INVALID");
  const records = JSON.parse(
    comment.body.slice(start + ledgerStart.length, end),
  );
  if (
    !Array.isArray(records) ||
    records.length > 100 ||
    records.some(
      (r) =>
        !/^[a-f0-9]{64}$/u.test(r.key) ||
        !sha(r.head) ||
        !id(r.ownerRun) ||
        ![
          "claimed",
          "accepted",
          "answered",
          "metadata",
          "incomplete",
          "stale",
        ].includes(r.status),
    )
  )
    throw Error("AUTOMATION_LEDGER_INVALID");
  return { comment, records };
}

export function claimRecord(state, repository, target, ownerRun) {
  const key = automaticKey(repository, target);
  if (state.records.some((r) => r.key === key)) return { duplicate: true, key };
  if (state.records.length >= 100) throw Error("AUTOMATION_LEDGER_LIMIT");
  const priorReview = state.records.findLast(
    (r) =>
      r.phase === "review" &&
      r.head === (target.prHead ?? target.head) &&
      ["accepted", "answered"].includes(r.status),
  );
  const record = {
    key,
    head: target.head,
    prHead: target.prHead ?? target.head,
    ownerRun: Number(ownerRun),
    run: target.runId ?? null,
    attempt: target.attempt ?? null,
    phase: target.questionDigest
      ? "question"
      : target.runId
        ? "ci"
        : target.postMerge
          ? "merge-notice"
          : "review",
    status: "claimed",
  };
  return {
    duplicate: false,
    key,
    priorReview: priorReview?.key ?? null,
    records: [...state.records, record],
  };
}

export function ledgerBody(human, records) {
  const body = `${AUTOMATION_MARKER}\n${human}\n\n${ledgerStart}${JSON.stringify(records)} -->`;
  if (body.length > 60000) throw Error("AUTOMATION_LEDGER_LIMIT");
  return body;
}

export function coverUnperformedReview(claim, repository, target, ownerRun) {
  if (
    target.questionDigest ||
    !target.runId ||
    target.postMerge ||
    claim.duplicate
  )
    return { claim, target };
  const review = claimRecord(
    { records: claim.records },
    repository,
    {
      number: target.number,
      head: target.head,
      prHead: target.head,
      kind: "review",
    },
    ownerRun,
  );
  if (review.duplicate) return { claim, target };
  return {
    claim: {
      ...claim,
      records: review.records.map((r) =>
        r.key === review.key ? { ...r, coveredBy: claim.key } : r,
      ),
    },
    target: {
      ...target,
      coversReview: true,
      ...(!["failure", "timed_out"].includes(target.conclusion)
        ? { kind: "review", metadataOnly: false }
        : {}),
    },
  };
}

export function finishRecord(state, key, ownerRun, status, details = {}) {
  const record = state.records.find((r) => r.key === key);
  if (
    !record ||
    record.ownerRun !== Number(ownerRun) ||
    record.status !== "claimed"
  )
    throw Error("AUTOMATION_CLAIM_LOST");
  return state.records.map((r) =>
    r.key === key || r.coveredBy === key ? { ...r, status, ...details } : r,
  );
}

export function citationEvidence(packet) {
  const records = [];
  const add = (pointer, value) => {
    if (value === undefined) return;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text || text.length > 24000) return;
    const sha256 = hash(text);
    records.push({
      id: hash(
        JSON.stringify([
          packet.repository,
          packet.number,
          packet.head,
          packet.runId ?? null,
          packet.attempt ?? null,
          pointer,
          sha256,
        ]),
      ),
      pointer,
      sha256,
      text,
    });
  };
  add("/identity", {
    repository: packet.repository,
    pr: packet.number,
    source: packet.head,
    prHead: packet.prHead,
    kind: packet.kind,
    run: packet.runId ?? null,
    attempt: packet.attempt ?? null,
    conclusion: packet.conclusion ?? null,
  });
  packet.files.forEach((file, i) => {
    add(`/files/${i}/patch`, file.patch);
    add(`/files/${i}/source`, file.source);
    (file.sourceExcerpts || []).forEach((excerpt, j) =>
      add(`/files/${i}/sourceExcerpts/${j}`, excerpt),
    );
  });
  (packet.relatedSources || []).forEach((file, i) =>
    add(`/relatedSources/${i}/source`, file.source),
  );
  packet.failedJobs.forEach((job, i) => {
    add(`/failedJobs/${i}/logs`, job.logs);
    add(`/failedJobs/${i}/failedSteps`, job.failedSteps);
  });
  add("/omissions", packet.omissions);
  add(
    "/runEvidence/identity",
    packet.runEvidence && {
      id: packet.runEvidence.id,
      attempt: packet.runEvidence.attempt,
      source: packet.runEvidence.source,
      event: packet.runEvidence.event,
      conclusion: packet.runEvidence.conclusion,
    },
  );
  (packet.runEvidence?.jobs || []).forEach((job, i) =>
    add(`/runEvidence/jobs/${i}`, job),
  );
  return records;
}

export function validateCitations(report, evidence) {
  const check = (citations) => {
    if (!Array.isArray(citations) || !citations.length || citations.length > 3)
      throw Error("INVALID_CITATION");
    return citations.map((c) => {
      const e = evidence.find((e) => e.id === c.id);
      if (
        !e ||
        typeof c.quote !== "string" ||
        !c.quote.length ||
        c.quote.length > 800 ||
        !e.text.includes(c.quote)
      )
        throw Error("CITATION_NOT_IN_ORIGINAL");
      return {
        id: c.id,
        quote: c.quote,
        pointer: e.pointer,
        sha256: e.sha256,
        exact: true,
      };
    });
  };
  return [
    ...check(report.citations),
    ...report.findings.flatMap((f) => check(f.citations)),
  ];
}

export function selectUnprocessedCI(runs, repository, target, records) {
  // Recover an overlapping CI event replaced in GitHub's one-pending-job queue.
  // Only completed canonical evidence for this exact current source is eligible.
  return runs
    .filter(
      (r) =>
        r.head_sha === target.head &&
        r.name === "CI" &&
        r.path === ".github/workflows/ci.yml" &&
        r.repository?.full_name === repository &&
        r.head_repository?.full_name === repository &&
        r.status === "completed" &&
        ["pull_request", "workflow_dispatch", "push"].includes(r.event) &&
        ["success", "failure", "timed_out", "cancelled", "skipped"].includes(
          r.conclusion,
        ),
    )
    .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)
    .find(
      (r) =>
        !records.some(
          (row) =>
            row.key ===
            automaticKey(repository, {
              ...target,
              runId: r.id,
              attempt: r.run_attempt,
            }),
        ),
    );
}

export function publicText(value) {
  return String(value)
    .replace(/(?:\/Users\/|\/home\/)[^\s"'<>]+/gu, "[private path omitted]")
    .replace(
      /https?:\/\/[^\s"'<>]*[?&](?:signature|sig|token|access_token|X-Amz-[^=\s]+)=[^\s"'<>]*/giu,
      "[authorizing URL omitted]",
    );
}

export function assertRemoteInput(value) {
  const stack = [value];
  while (stack.length) {
    const entry = stack.pop();
    if (typeof entry === "string" && publicText(entry) !== entry)
      throw Error("NONPUBLIC_REMOTE_INPUT");
    if (entry && typeof entry === "object")
      stack.push(...Object.keys(entry), ...Object.values(entry));
  }
}

export function sanitizeRemoteProjection(value) {
  // Transform decoded scalars, never serialized JSON: a quoted source string
  // may contain escaped quotes immediately after a redacted path.
  if (typeof value === "string") return publicText(value);
  if (Array.isArray(value)) return value.map(sanitizeRemoteProjection);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sanitizeRemoteProjection(entry),
      ]),
    );
  return value;
}
