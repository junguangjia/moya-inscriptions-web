import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { categories } from "./confidentiality-scan.mjs";
import { publicText, assertRemoteInput } from "./cursor-automation.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (category) => {
  throw Error(category);
};
const scannedJSON = (text) => {
  if (safeText(text) === null) fail("UNSAFE_MODEL_OUTPUT");
  const value = JSON.parse(text);
  assertRemoteInput(value);
  return value;
};

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

// Retain only a scanned answer, never stderr, credentials or arbitrary envelope
// fields. Redact an entire sensitive scalar/key rather than guess secret spans.
export function retainedResponse(raw) {
  let redactions = 0;
  let visited = 0;
  const text = (value) => {
    let decoded = value;
    for (let i = 0; i < 3; i++) {
      if (safeText(decoded) === null) {
        redactions++;
        return "[REDACTED: credential-bearing text]";
      }
      decoded = decoded
        .replace(/\\u([0-9a-f]{4})/giu, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16)),
        )
        .replace(/\\x([0-9a-f]{2})/giu, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16)),
        )
        .replace(/\\[nrt]/gu, " ");
    }
    if (safeText(decoded) === null) {
      redactions++;
      return "[REDACTED: credential-bearing text]";
    }
    if (publicText(decoded) !== decoded) {
      redactions++;
      return "[REDACTED: nonpublic output]";
    }
    return safeText(value);
  };
  const visit = (value, depth = 0) => {
    if (++visited > 10000 || depth > 32) {
      redactions++;
      return "[REDACTED: retention limit]";
    }
    if (typeof value === "string") return text(value);
    if (Array.isArray(value))
      return value.map((item) => visit(item, depth + 1));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item], index) => {
          const safeKey = text(key);
          return [
            safeKey === key ? key : `[redacted-key-${index}]`,
            visit(item, depth + 1),
          ];
        }),
      );
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
  // Scan the exact artifact representation AND all decoded retained values.
  scannedJSON(JSON.stringify(artifact));
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
