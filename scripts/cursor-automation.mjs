import { createHash } from "node:crypto";
import { categories } from "./confidentiality-scan.mjs";

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

// Diagnostic context is authorized. Only credential-bearing values are removed;
// the unchanged core scanner remains the final check, not a new policy service.
const credentialName =
  /^(?:(?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret[_-]?(?:access[_-]?)?key|api[_-]?key|access[_-]?token|refresh[_-]?token|security[_-]?token|session[_-]?token|client[_-]?secret|token)|(?:db|database|cos|cloud)?(?:Password|SecretKey|ApiKey|AccessToken|RefreshToken)|authorization|cookie|set-cookie)$/iu;
const placeholder =
  /^(?:|\[REDACTED\]|\.\.\.|<[^<>\r\n]+>|\$\{[^{}\r\n]+\}|\$[A-Z_][A-Z0-9_]*|__[A-Z0-9_]+__|(?:EXAMPLE|PLACEHOLDER|REPLACE_ME|REDACTED|SYNTHETIC|TEST_ONLY|YOUR)(?:[_-][A-Z0-9_-]+)?|(?:example|placeholder|synthetic|fictional|test-only|dummy|fake|changeme|test|testing)(?:[-_][a-z0-9_-]+)?)$/iu;
const assignment =
  /(?:\b([A-Za-z_][\w-]*)|["']([A-Za-z_][\w-]*)["'])[ \t]*(:=|===|!==|==|!=|=(?!=|>)|:(?!=))[ \t]*(?:(["'])((?:\\.|[^\\\r\n])*?)\4|([^\s,;#{}()[\]"'`]+))/dgu;

const escapedAssignment = new RegExp(
  assignment.source.replaceAll(
    "[A-Za-z_][\\w-]*",
    String.raw`(?:[A-Za-z_]|\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2})(?:[\w-]|\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2})*`,
  ),
  assignment.flags,
);
const decodedIdentifier = (value) => {
  for (let pass = 0; pass < 3; pass++)
    value = value.replace(
      /\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/gu,
      (_, unicode, hex) => String.fromCharCode(parseInt(unicode ?? hex, 16)),
    );
  return value;
};

export function credentialText(value, field = "") {
  field = decodedIdentifier(field);
  const plain = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, " ");
  // Capture quoted literal boundaries before decoding escaped quote characters.
  // This protects the complete value even when a Unicode escape becomes a quote.
  const rawSpans = [];
  for (const match of plain.matchAll(escapedAssignment)) {
    const name = decodedIdentifier(match[1] ?? match[2]);
    if (
      match[4] &&
      credentialName.test(name) &&
      !/^(?:authorization|cookie|set-cookie)$/iu.test(name) &&
      categories(`${name}=${JSON.stringify(match[5])}`).includes(
        "CREDENTIAL_LITERAL",
      )
    )
      rawSpans.push({
        start: match.indices[5][0],
        end: match.indices[5][1],
        category: "CREDENTIAL_LITERAL",
        replacement: "REDACTED",
      });
  }
  let decoded = plain;
  let positions = Array.from({ length: plain.length }, (_, i) => [i, i + 1]);
  // Map decoded matches back to the original text. Safe escapes and surrounding
  // prose stay byte-for-byte intact, including quoted source and stack traces.
  for (let pass = 0; pass < 3; pass++) {
    let next = [];
    let at = 0;
    decoded = decoded.replace(
      /\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([nrt]))/gu,
      (match, unicode, hex, control, index) => {
        next = next.concat(positions.slice(at, index));
        next.push([
          positions[index][0],
          positions[index + match.length - 1][1],
        ]);
        at = index + match.length;
        return control
          ? { n: "\n", r: "\r", t: "\t" }[control]
          : String.fromCharCode(parseInt(unicode ?? hex, 16));
      },
    );
    next = next.concat(positions.slice(at));
    positions = next;
  }
  const spans = [];
  const add = (start, end, category, replacement) => {
    if (end > start) spans.push({ start, end, category, replacement });
  };
  const matches = (pattern, category, group = 0) => {
    for (const match of decoded.matchAll(pattern)) {
      const [start, end] = match.indices[group];
      if (!placeholder.test(decoded.slice(start, end)))
        add(start, end, category);
    }
  };
  matches(
    /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/dgu,
    "PRIVATE_KEY",
  );
  matches(
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,})\b/dgu,
    "API_TOKEN",
  );
  matches(
    /\b(?:Bearer|Basic)[ \t]+([A-Za-z0-9+/=_-]{12,})/dgu,
    "AUTH_MATERIAL",
    1,
  );
  matches(
    /\bAuthorization:[ \t]*(?:Bearer|Basic)[ \t]+([^\s"'<>`]+)/dgiu,
    "AUTH_MATERIAL",
    1,
  );
  if (/^authorization$/iu.test(field))
    matches(/^(?:Bearer|Basic)[ \t]+([^\s]+)/dgiu, "AUTH_MATERIAL", 1);
  matches(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/dgu,
    "AUTH_MATERIAL",
  );
  const cookies = (text, offset) => {
    for (const match of text.matchAll(/(?:^|;)[ \t]*([\w-]+)=([^;\r\n]*)/dgu)) {
      if (
        /^(?:path|domain|expires|max-age|samesite|priority|partitioned)$/iu.test(
          match[1],
        ) ||
        placeholder.test(match[2])
      )
        continue;
      add(
        offset + match.indices[2][0],
        offset + match.indices[2][1],
        "SESSION_COOKIE",
      );
    }
  };
  for (const match of decoded.matchAll(
    /\b(?:Cookie|Set-Cookie):[ \t]*([^\r\n]+)/dgiu,
  ))
    cookies(match[1], match.indices[1][0]);
  // Use named fields as context too: a short password need not have a token
  // prefix. Cookie pairs keep their names/attributes and redact only values.
  if (credentialName.test(field) && !placeholder.test(decoded)) {
    if (/^(?:cookie|set-cookie)$/iu.test(field)) cookies(decoded, 0);
    else if (
      !/^authorization$/iu.test(field) ||
      !/^(?:Bearer|Basic)\s/iu.test(decoded)
    )
      add(0, decoded.length, "CREDENTIAL_LITERAL");
  }
  for (const match of decoded.matchAll(assignment)) {
    const name = match[1] ?? match[2];
    if (
      !credentialName.test(name) ||
      /[?&]/u.test(decoded[match.index - 1] ?? "")
    )
      continue;
    const group = match[4] ? 5 : 6;
    const [start, end] = match.indices[group];
    if (/^(?:cookie|set-cookie)$/iu.test(name)) {
      cookies(match[group], start);
      continue;
    }
    if (
      /^authorization$/iu.test(name) &&
      /^(?:Bearer|Basic)\b/iu.test(match[group])
    ) {
      const auth = /^(?:Bearer|Basic)[ \t]+(\S+)/diu.exec(match[group]);
      if (auth && !placeholder.test(auth[1]))
        add(
          start + auth.indices[1][0],
          start + auth.indices[1][1],
          "AUTH_MATERIAL",
        );
      continue;
    }
    const literal = match[group];
    const bareValue =
      !match[4] &&
      /^(?:=|:)$/.test(match[3]) &&
      !placeholder.test(literal) &&
      !/^(?:(?:string|number|boolean|unknown|never|any|void|undefined|null|false|true)$|process\.env(?:\.|$)|import\.meta\.env(?:\.|$)|os\.environ(?:\.|$)|getenv$|env$)/u.test(
        literal,
      );
    if (bareValue || categories(match[0]).includes("CREDENTIAL_LITERAL"))
      add(
        start,
        end,
        "CREDENTIAL_LITERAL",
        match[4] ? "REDACTED" : "[REDACTED]",
      );
  }
  // Keep the URL, username and non-authorizing query parameters intact.
  matches(
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`/@:]+:([^\s<>"'`/@]*)@/dgiu,
    "PASSWORD_CONNECTION_URL",
    1,
  );
  for (const match of decoded.matchAll(/[?&]([^\s=&#]+)=([^\s&#"'<>`]+)/dgu)) {
    let name;
    try {
      name = decodeURIComponent(match[1]);
    } catch {
      continue;
    }
    if (
      /^(?:q-signature|x-amz-signature|x-amz-security-token|x-goog-signature|signature|sig|password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token)$/iu.test(
        name,
      ) &&
      !placeholder.test(match[2])
    )
      add(...match.indices[2], "AUTHORIZING_URL", "[REDACTED]");
  }
  // The core scanner can recognize a residual form not located above. Limit a
  // conservative fallback to that line, never discard the surrounding answer.
  const masked = (ranges, source = decoded) => {
    let result = source;
    for (const range of [...ranges].sort((a, b) => b.start - a.start))
      result =
        result.slice(0, range.start) +
        (range.replacement ?? "REDACTED") +
        result.slice(range.end);
    return result;
  };
  const merge = (ranges) => {
    const result = [];
    for (const range of [...ranges].sort(
      (a, b) => a.start - b.start || b.end - a.end,
    )) {
      const last = result.at(-1);
      if (last && range.start < last.end) {
        last.end = Math.max(last.end, range.end);
        if (range.replacement) last.replacement = range.replacement;
      } else result.push({ ...range });
    }
    return result;
  };
  // Check each original line with its local known spans to preserve positions.
  let offset = 0;
  for (const line of decoded.split("\n")) {
    const local = merge(
      spans
        .filter((s) => s.start < offset + line.length && s.end > offset)
        .map((s) => ({
          ...s,
          start: Math.max(0, s.start - offset),
          end: Math.min(line.length, s.end - offset),
        })),
    );
    if (categories(masked(local, line)).length)
      add(offset, offset + line.length, "UNLOCATED_CREDENTIAL_LINE");
    offset += line.length + 1;
  }
  const merged = merge([
    ...spans.map((s) => ({
      ...s,
      start: positions[s.start][0],
      end: positions[s.end - 1][1],
    })),
    ...rawSpans,
  ]);
  const redactionCounts = {};
  for (const span of merged)
    redactionCounts[span.category] = (redactionCounts[span.category] ?? 0) + 1;
  const text = masked(merged, plain);
  // A credential label/placeholder alone is not a usable model answer. Keys of
  // structured objects also do not make an otherwise empty reply meaningful.
  const remainder = text
    .replaceAll("[REDACTED]", "REDACTED")
    .replace(/^(?:Cookie|Set-Cookie):[^\r\n]*$/gimu, "")
    .replace(/(?:Authorization:[ \t]*)?(?:Bearer|Basic)[ \t]+REDACTED/giu, "")
    .replace(assignment, (whole, name, quoted, op, quote, literal, bare) =>
      credentialName.test(name ?? quoted) && placeholder.test(literal ?? bare)
        ? ""
        : whole,
    )
    .replace(/REDACTED|\[REDACTED[^\]]*\]/gu, "")
    .trim();
  return {
    text,
    redactions: merged.length,
    redactionCounts,
    useful: !credentialName.test(field) && /[\p{L}\p{N}]/u.test(remainder),
  };
}

export function publicText(value) {
  return credentialText(value).text;
}

export function assertRemoteInput(value) {
  if (JSON.stringify(sanitizeRemoteProjection(value)) !== JSON.stringify(value))
    throw Error("NONPUBLIC_REMOTE_INPUT");
}

export function sanitizeRemoteProjection(value, field = "") {
  // Transform decoded scalars, never serialized JSON; preserve field context.
  if (typeof value === "string") return credentialText(value, field).text;
  if (Array.isArray(value))
    return value.map((entry) => sanitizeRemoteProjection(entry, field));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry], index) => [
        publicText(key) === key ? key : `[redacted-key-${index}]`,
        sanitizeRemoteProjection(entry, key),
      ]),
    );
  if (value != null && credentialName.test(field))
    return credentialText(String(value), field).text;
  return value;
}
