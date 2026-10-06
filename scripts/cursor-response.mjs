import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { categories } from "./confidentiality-scan.mjs";
import { credentialText, assertRemoteInput } from "./cursor-automation.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (category) => {
  throw Error(category);
};
export function scannedResponseJSON(text) {
  const value = JSON.parse(text);
  // JSON escaping is representation, not credential content. Scan every decoded
  // key/value and check field-aware sanitization; otherwise safe source such as
  // password="REDACTED" is misread as an unquoted backslash credential.
  assertRemoteInput(value);
  const pending = [value];
  while (pending.length) {
    const entry = pending.pop();
    if (typeof entry === "string" && safeText(entry) === null)
      fail("UNSAFE_MODEL_OUTPUT");
    if (entry && typeof entry === "object") {
      for (const [key, item] of Object.entries(entry)) pending.push(key, item);
    }
  }
  return value;
}

export function safeText(text, filename = "context.txt") {
  // Remove terminal control sequences before scanning. Never send raw diagnostics
  // to the model or to Actions output, including on exception paths.
  const plain = String(text)
    // Strip ANSI terminal escapes; control characters otherwise separate tokens.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, " ");
  return categories(plain, filename).length || categories(filename).length
    ? null
    : plain;
}

// Retain the useful answer around masked credential values. Raw transport and
// arbitrary envelope fields remain in memory only.
export function retainedResponse(raw) {
  let redactions = 0;
  let visited = 0;
  let useful = false;
  const redactionCounts = {};
  const text = (value, field = "", isKey = false) => {
    const safe = credentialText(value, field);
    redactions += safe.redactions;
    for (const [category, count] of Object.entries(safe.redactionCounts))
      redactionCounts[category] = (redactionCounts[category] ?? 0) + count;
    if (!isKey) useful ||= safe.useful;
    return safe.text;
  };
  const visit = (value, depth = 0, field = "") => {
    if (++visited > 10000 || depth > 32) {
      redactions++;
      redactionCounts.RETENTION_LIMIT =
        (redactionCounts.RETENTION_LIMIT ?? 0) + 1;
      return "[REDACTED: retention limit]";
    }
    if (typeof value === "string") return text(value, field);
    if (Array.isArray(value))
      return value.map((item) => visit(item, depth + 1, field));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item], index) => {
          const safeKey = text(key, "", true);
          return [
            safeKey === key ? key : `[redacted-key-${index}]`,
            visit(item, depth + 1, key),
          ];
        }),
      );
    if (value != null) {
      const safe = text(String(value), field);
      if (safe !== String(value)) return safe;
    }
    return value;
  };
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 256 * 1024)
    fail("MODEL_RESPONSE_TOO_LARGE");
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    /* Retain scanned malformed transport. */
  }
  const body = envelope?.result;
  let parsed;
  let format = "text";
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
      format = "json";
    } catch {
      parsed = body;
    }
  } else parsed = body === undefined ? null : body;
  const artifact = {
    version: 1,
    transportSha256: digest(raw),
    transportBytes: Buffer.byteLength(raw),
    format: envelope === undefined ? "invalid-transport" : format,
    body: visit(envelope === undefined ? raw : parsed),
    redactions: 0,
    accepted: false,
  };
  artifact.redactions = redactions;
  artifact.redactionCounts = Object.entries(redactionCounts).map(
    ([category, count]) => ({ category, count }),
  );
  artifact.usable = useful && artifact.format !== "invalid-transport";
  // Validate the exact stored JSON with decoded scalar and named-field checks.
  scannedResponseJSON(JSON.stringify(artifact));
  return { artifact, envelope, body };
}

// The answer is a document, not an instruction or an executable request.
// Optional structured validation is independent of retaining/displaying it.
export function readableResponse(artifact) {
  if (artifact.format === "invalid-transport" || artifact.body == null)
    return "";
  return typeof artifact.body === "string"
    ? artifact.body
    : JSON.stringify(artifact.body, null, 2);
}

export function responseValidationError(error) {
  return error instanceof SyntaxError
    ? "RESPONSE_JSON_INVALID"
    : /^[A-Z_]{3,60}$/u.test(error?.message ?? "")
      ? error.message
      : "RESPONSE_VALIDATION_INCOMPLETE";
}
