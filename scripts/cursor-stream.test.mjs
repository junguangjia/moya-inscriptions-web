import { setTimeout } from "node:timers";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { runCursorStream } from "./cursor-stream.mjs";

test("silent waiting stays unconfirmed and a later official terminal event completes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-stream-"));
  try {
    const path = join(dir, "progress.json");
    const call = runCursorStream(
      process.execPath,
      [
        "-e",
        `
      console.log(JSON.stringify({type:'system',subtype:'init',cwd:'private-path'}));
      setTimeout(()=>console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'answer'})),250);
    `,
      ],
      { progressPath: path, heartbeatMs: 15 },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const waiting = JSON.parse(readFileSync(path));
    assert.equal(waiting.processStatus, "running");
    assert.equal(waiting.activity, "unconfirmed");
    assert.equal(waiting.hiddenReasoningVerified, false);
    const result = await call;
    assert.equal(result.status, 0);
    assert.equal(result.error, undefined);
    assert.equal(JSON.parse(result.stdout).result, "answer");
    assert.equal(result.progress.terminalResultReceived, true);
    assert.equal(readFileSync(path, "utf8").includes("private-path"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("partial assistant and paired tool events retain metadata, never their content", async () => {
  const result = await runCursorStream(process.execPath, [
    "-e",
    `
    for (const event of [
      {type:'assistant',message:{content:[{text:'private evidence text'}]}},
      {type:'tool_call',subtype:'started',tool_call:{readToolCall:{args:{path:'private-input'}}}},
      {type:'tool_call',subtype:'completed'},
      {type:'result',subtype:'success',is_error:false,result:'done'}
    ]) console.log(JSON.stringify(event));
  `,
  ]);
  assert.equal(result.progress.toolsStarted, 1);
  assert.deepEqual(result.progress.toolKinds, { readToolCall: 1 });
  assert.equal(result.progress.toolsCompleted, 1);
  assert.equal(result.progress.eventCounts.assistant, 1);
  assert.equal(JSON.stringify(result.progress).includes("private"), false);
  assert.equal(result.progress.hiddenReasoningVerified, false);
});

test("exit without a terminal result is incomplete and diagnostics stay out of metadata", async () => {
  const result = await runCursorStream(process.execPath, [
    "-e",
    "process.stderr.write('private diagnostic');",
  ]);
  assert.equal(result.error.code, "STREAM_TERMINAL_MISSING");
  assert.equal(result.progress.terminalResultReceived, false);
  assert.equal(
    JSON.stringify(result.progress).includes("private diagnostic"),
    false,
  );
});

test("output resource bounds stop only the owned invocation without a retry", async () => {
  const result = await runCursorStream(
    process.execPath,
    ["-e", "console.log('x'.repeat(2000));setInterval(()=>{},1000);"],
    { maxBytes: 1024 },
  );
  assert.equal(result.error.code, "STREAM_OUTPUT_LIMIT");
  assert.equal(result.progress.transportError, "STREAM_OUTPUT_LIMIT");
  assert.equal(result.progress.terminalResultReceived, false);
});

test("echo and partial-event overhead do not consume the retained answer bound", async () => {
  const result = await runCursorStream(process.execPath, [
    "-e",
    `
    console.log(JSON.stringify({type:'user',message:{content:'q'.repeat(113000)}}));
    for(let i=0;i<1000;i++)console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'delta'}]},session_id:'synthetic-session-repro-000000000000000000000000',timestamp:'2026-10-06T00:00:00.000Z'}));
    console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'a'.repeat(5000)}));
    `,
  ]);
  assert.ok(result.progress.stdoutBytes > 256 * 1024);
  assert.equal(result.error, undefined);
  assert.equal(result.progress.eventCounts.assistant, 1000);
  assert.equal(JSON.parse(result.stdout).result.length, 5000);
});

test("non-object NDJSON is a finite safe transport error", async () => {
  const result = await runCursorStream(process.execPath, [
    "-e",
    "console.log('null');setInterval(()=>{},1000);",
  ]);
  assert.equal(result.error.code, "INVALID_STREAM_EVENT");
  assert.equal(result.progress.processStatus, "terminated");
});

test("progress storage failure returns a safe retention gap without escaping callbacks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-stream-storage-"));
  try {
    writeFileSync(join(dir, "file"), "synthetic");
    const result = await runCursorStream(
      process.execPath,
      ["-e", "setInterval(()=>{},1000);"],
      { progressPath: join(dir, "file/progress.json") },
    );
    assert.equal(result.error.code, "STREAM_PROGRESS_RETENTION_FAILED");
    assert.equal(
      result.progress.retentionGap,
      "STREAM_PROGRESS_RETENTION_FAILED",
    );
    assert.equal(result.progress.processStatus, "terminated");
    assert.equal(JSON.stringify(result.progress).includes(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an admitted 360K prompt echo is bounded separately from the 256KiB final answer", async () => {
  const input = "x".repeat(360000);
  const result = await runCursorStream(
    process.execPath,
    [
      "-e",
      `
let input=''; process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);
process.stdin.on('end',()=>{console.log(JSON.stringify({type:'user',message:{content:[{text:input}]}}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}));});
`,
    ],
    { input },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.progress.eventCounts.user, 1);
  assert.equal(result.progress.terminalResultReceived, true);
  assert.equal(JSON.parse(result.stdout).result, "done");
  assert.ok(result.stdout.length < 1000);
});

test("JSON-rich admitted prompt accounts for official user-event escaping overhead", async () => {
  const input = JSON.stringify({
    records: Array.from({ length: 4500 }, () => ({
      text: '"native"\n\t\\ row',
      source: "a".repeat(20),
    })),
  });
  assert.ok(Buffer.byteLength(input) < 360000);
  assert.ok(
    Buffer.byteLength(JSON.stringify(input)) > Buffer.byteLength(input) + 4096,
  );
  const result = await runCursorStream(
    process.execPath,
    [
      "-e",
      `
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'user',message:{content:[{text:input}]}}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}));});
`,
    ],
    { input },
  );
  assert.equal(result.error, undefined);
  assert.equal(JSON.parse(result.stdout).result, "done");
  assert.equal(result.progress.eventCounts.user, 1);
});
