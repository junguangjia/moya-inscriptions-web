import { setTimeout } from "node:timers";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
