import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { URL, URLSearchParams } from "node:url";
import { setImmediate } from "node:timers/promises";

const { AbortController } = globalThis;
const code = readFileSync(
  new URL("./ui/companion.js", import.meta.url),
  "utf8",
);

function browser() {
  const calls = [],
    timers = [],
    listeners = {};
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.textContent = "";
      this.hidden = false;
    }
    append(...children) {
      this.children.push(...children);
    }
    replaceChildren(...children) {
      this.children = children;
    }
    setAttribute() {}
  }
  const body = new Element("body");
  const location = { pathname: "/projects/1/data/", search: "?task=8" };
  const dm = { task: { id: 8 }, lsf: { task: { id: 8 }, isLoading: false } };
  const window = {
    innerWidth: 1300,
    dataManager: {
      lsf: dm,
      store: { loadingData: false },
      on: (name, fn) => {
        listeners[name] = fn;
      },
      off: () => {},
    },
    addEventListener: () => {},
  };
  const context = {
    window,
    location,
    URLSearchParams,
    Number,
    AbortController,
    document: { body, hidden: false, createElement: (tag) => new Element(tag) },
    setInterval: (fn) => {
      timers.push(fn);
      return 1;
    },
    clearInterval: () => {},
    fetch: (url, options) =>
      new Promise((resolve) => calls.push({ url, options, resolve })),
  };
  vm.runInNewContext(code, context);
  return { calls, timers, body, location, window, dm, root: body.children[0] };
}
function response(task, project = 1, name = "Synthetic object") {
  return {
    ok: true,
    json: async () => ({
      task,
      project,
      kind: "group",
      current: {
        code: "AV-0001",
        name,
        nameSource: "local",
        membership: "synthetic",
        synthetic: true,
        assets: [],
      },
      directory: "http://127.0.0.1:3580/objects",
      targets: [],
    }),
  };
}
async function settled() {
  await setImmediate();
}
function texts(node) {
  return [node.textContent, ...node.children.flatMap(texts)]
    .filter(Boolean)
    .join(" ");
}

test("a late task-A response cannot decorate task B or change native review state", async () => {
  const b = browser(),
    original = JSON.stringify(b.window.dataManager.lsf);
  assert.match(b.calls[0].url, /task=8$/);
  b.location.search = "?task=9";
  b.dm.task.id = 9;
  b.dm.lsf.task.id = 9;
  b.timers[0]();
  assert.equal(b.calls.length, 2);
  b.calls[1].resolve(response(9, 1, "Task B"));
  await settled();
  assert.equal(b.root.hidden, false);
  assert.match(texts(b.root), /Task B/);
  b.calls[0].resolve(response(8, 1, "Task A"));
  await settled();
  assert.doesNotMatch(texts(b.root), /Task A/);
  assert.deepEqual(JSON.parse(original), {
    task: { id: 8 },
    lsf: { task: { id: 8 }, isLoading: false },
  });
  assert.equal(b.dm.task.id, 9); // Companion never mutates this native identity.
});

test("wrapper/editor mismatch and loading suppress identity until actual task settles", async () => {
  const b = browser();
  b.dm.task.id = 9;
  b.location.search = "?task=9";
  b.window.dataManager.store.loadingData = true;
  b.timers[0]();
  assert.equal(b.root.hidden, true);
  assert.equal(b.calls.length, 1);
  b.window.dataManager.store.loadingData = false;
  b.timers[0]();
  assert.equal(b.calls.length, 1);
  b.dm.lsf.task.id = 9;
  b.dm.lsf.isLoading = true;
  b.timers[0]();
  assert.equal(b.calls.length, 1);
  b.dm.lsf.isLoading = false;
  b.timers[0]();
  assert.equal(b.calls.length, 2);
  b.calls[1].resolve(response(9));
  await settled();
  assert.equal(b.root.hidden, false);
});

test("native project navigation uses its actual project and leaving review clears panel", async () => {
  const b = browser();
  b.calls[0].resolve(response(8));
  await settled();
  b.location.pathname = "/projects/2/data/";
  b.timers[0]();
  assert.match(b.calls[1].url, /project=2&task=8$/);
  b.calls[1].resolve(response(8, 2));
  await settled();
  assert.equal(b.root.hidden, false);
  b.location.pathname = "/projects/";
  b.timers[0]();
  assert.equal(b.root.hidden, true);
});

test("names containing markup remain text inside the isolated companion", async () => {
  const b = browser(),
    name = "</script><img src=https://example.invalid>SYNTHETIC";
  b.calls[0].resolve(response(8, 1, name));
  await settled();
  assert.match(texts(b.root), /<\/script><img/);
  assert.equal(b.calls.length, 1);
  const tags = (node) => [node.tag, ...node.children.flatMap(tags)];
  assert.equal(tags(b.root).includes("script"), false);
  assert.equal(tags(b.root).includes("input"), false);
  assert.equal(tags(b.root).includes("button"), false);
});
