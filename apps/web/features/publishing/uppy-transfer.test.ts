// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TRANSFER_FILE_COPY_MAX_BYTES,
  TRANSFER_TIMING,
  createUppyTransfer,
} from "./uppy-transfer";

import type { TransferOutcome, TransferTimers } from "./uppy-transfer";

/** The XHR boundary: records every real send so retries would be visible. */
class FakeXhr {
  static sends: FakeXhr[] = [];
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  statusText = "";
  responseText = "";
  responseType = "";
  response: unknown = null;
  withCredentials = false;
  aborted = false;
  upload: {
    onprogress:
      | ((event: {
          lengthComputable: boolean;
          loaded: number;
          total: number;
        }) => void)
      | null;
  } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
    FakeXhr.sends.push(this);
  }
  abort() {
    this.aborted = true;
  }
  answer(status: number, text: string) {
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
  fail() {
    this.status = 0;
    this.onerror?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
}

class ControlledFileReader {
  static reads: ControlledFileReader[] = [];
  result: ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;
  source: Blob | null = null;
  readAsArrayBuffer(source: Blob) {
    this.source = source;
    ControlledFileReader.reads.push(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  complete(bytes: Uint8Array) {
    this.result = bytes.buffer as ArrayBuffer;
    this.onload?.();
  }
}

const nativeFileReader = globalThis.FileReader;
const readBytes = (body: Blob): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const reader = new nativeFileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = reject;
    reader.readAsArrayBuffer(body);
  });

const controlFileReads = () => {
  ControlledFileReader.reads = [];
  vi.spyOn(globalThis, "FileReader").mockImplementation(function () {
    return new ControlledFileReader() as unknown as FileReader;
  });
};

const flush = async () => {
  for (let index = 0; index < 10; index += 1)
    await vi.advanceTimersByTimeAsync(0);
};

const manualTimers = () => {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  const timers: TransferTimers = {
    setTimeout: (callback, ms) => {
      const id = next++;
      pending.set(id, { callback, ms });
      return id;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
  };
  const fire = (ms: number) => {
    for (const [id, timer] of [...pending]) {
      if (timer.ms !== ms) continue;
      pending.delete(id);
      timer.callback();
    }
  };
  return { timers, fire, pending };
};

const request = (id: string, size = 32) => ({
  id,
  endpoint: `/api/community/publishing/uploads/media-component-${id.padStart(32, "0")}`,
  headers: {
    "content-type": "application/octet-stream",
    "x-author-account": `user-${"a".repeat(32)}`,
    "x-upload-attempt": "0f8fad5b-d9cb-469f-a165-70867728950e",
  },
  body: new Blob([new Uint8Array(size)]),
});

describe("Uppy component transfer", () => {
  const original = globalThis.XMLHttpRequest;
  beforeEach(() => {
    vi.useFakeTimers();
    FakeXhr.sends = [];
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
  });
  afterEach(async () => {
    // Uppy schedules its initial online check for 3s and does not cancel it
    // in destroy(). Execute pending library timers before jsdom is torn down;
    // errors still fail here instead of leaking into an unrelated test file.
    try {
      await vi.runAllTimersAsync();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      globalThis.XMLHttpRequest = original;
      vi.restoreAllMocks();
    }
  });

  it("posts the raw component bytes to its own endpoint with its own headers", async () => {
    const { timers } = manualTimers();
    const transfer = createUppyTransfer(2, timers);
    const settled = vi.fn<(outcome: TransferOutcome) => void>();
    const progress = vi.fn();
    const first = request("1");
    transfer.start(first, { onProgress: progress, onSettled: settled });
    await flush();
    expect(FakeXhr.sends).toHaveLength(1);
    const xhr = FakeXhr.sends[0]!;
    expect(xhr.method.toLowerCase()).toBe("post");
    expect(xhr.url).toBe(first.endpoint);
    expect(xhr.body).not.toBe(first.body);
    expect(xhr.body).toBeInstanceOf(Blob);
    expect((xhr.body as Blob).size).toBe(first.body.size);
    expect((xhr.body as Blob).type).toBe(first.body.type);
    expect(xhr.headers).toMatchObject(first.headers);
    xhr.progress(16, 32);
    expect(progress).toHaveBeenCalledWith(16, 32);
    xhr.answer(200, '{"ok":true}');
    await flush();
    expect(settled).toHaveBeenCalledWith({
      status: 200,
      responseText: '{"ok":true}',
      stalled: false,
    });
    transfer.dispose();
  });

  it("sends small picked Files as byte-identical memory Blobs, including retained JPEGs", async () => {
    controlFileReads();
    const { timers } = manualTimers();
    const transfer = createUppyTransfer(2, timers);
    const bytes = Uint8Array.from({ length: 4096 }, (_, i) => i % 251);
    const file = new File([bytes], "synthetic-photo.jpeg", {
      type: "image/jpeg",
    });
    const selected = { ...request("10"), body: file };
    const settled = vi.fn();
    transfer.start(selected, { onProgress: vi.fn(), onSettled: settled });
    await flush();
    expect(FakeXhr.sends).toHaveLength(0);
    expect(ControlledFileReader.reads[0]!.source).toBe(file);
    ControlledFileReader.reads[0]!.complete(bytes);
    await flush();
    const xhr = FakeXhr.sends[0]!;
    expect(xhr.body).toBeInstanceOf(Blob);
    expect(xhr.body).not.toBeInstanceOf(File);
    expect((xhr.body as Blob).size).toBe(file.size);
    expect((xhr.body as Blob).type).toBe(file.type);
    const transferredBytes = readBytes(xhr.body as Blob);
    await vi.runAllTimersAsync();
    expect(await transferredBytes).toEqual(bytes);
    expect(xhr.headers).toMatchObject(selected.headers);
    xhr.answer(200, '{"ok":true}');
    await flush();
    expect(settled).toHaveBeenCalledOnce();
    transfer.dispose();
  });

  it("does not materialize a large Original File into a whole-file buffer", async () => {
    controlFileReads();
    const { timers } = manualTimers();
    const transfer = createUppyTransfer(1, timers);
    const file = new File(
      [new Uint8Array(TRANSFER_FILE_COPY_MAX_BYTES + 1)],
      "synthetic-original.jpeg",
      { type: "image/jpeg" },
    );
    transfer.start(
      { ...request("11"), body: file },
      { onProgress: vi.fn(), onSettled: vi.fn() },
    );
    await flush();
    expect(ControlledFileReader.reads).toHaveLength(0);
    expect(FakeXhr.sends).toHaveLength(1);
    const body = FakeXhr.sends[0]!.body as Blob;
    expect(body).not.toBeInstanceOf(File);
    expect(body.size).toBe(file.size);
    expect(body.type).toBe(file.type);
    transfer.dispose();
  });

  it.each(["abort", "dispose"] as const)(
    "never sends after %s during File preparation",
    async (action) => {
      controlFileReads();
      const { timers, pending } = manualTimers();
      const transfer = createUppyTransfer(1, timers);
      const settled = vi.fn();
      transfer.start(
        {
          ...request("12"),
          body: new File([new Uint8Array(32)], "synthetic.jpeg"),
        },
        { onProgress: vi.fn(), onSettled: settled },
      );
      const reader = ControlledFileReader.reads[0]!;
      if (action === "abort") transfer.abort("12");
      else transfer.dispose();
      expect(reader.aborted).toBe(true);
      reader.complete(new Uint8Array(32));
      await flush();
      expect(FakeXhr.sends).toHaveLength(0);
      expect(settled).not.toHaveBeenCalled();
      expect(pending.size).toBe(0);
      transfer.dispose();
    },
  );

  it("bounds a stalled local File read and discards its late result", async () => {
    controlFileReads();
    const { timers, fire, pending } = manualTimers();
    const transfer = createUppyTransfer(1, timers);
    const settled = vi.fn();
    transfer.start(
      {
        ...request("13"),
        body: new File([new Uint8Array(32)], "synthetic.jpeg"),
      },
      { onProgress: vi.fn(), onSettled: settled },
    );
    const reader = ControlledFileReader.reads[0]!;
    fire(TRANSFER_TIMING.stallMs);
    reader.complete(new Uint8Array(32));
    await flush();
    expect(reader.aborted).toBe(true);
    expect(FakeXhr.sends).toHaveLength(0);
    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith({
      status: 0,
      responseText: "",
      stalled: true,
    });
    expect(pending.size).toBe(0);
    transfer.dispose();
  });

  it.each(["error", "short-read"] as const)(
    "does not send unreadable source bytes after %s",
    async (failure) => {
      controlFileReads();
      const { timers, pending } = manualTimers();
      const transfer = createUppyTransfer(1, timers);
      const settled = vi.fn();
      transfer.start(
        {
          ...request("14"),
          body: new File([new Uint8Array(32)], "synthetic.jpeg"),
        },
        { onProgress: vi.fn(), onSettled: settled },
      );
      const reader = ControlledFileReader.reads[0]!;
      if (failure === "error") reader.onerror?.();
      else reader.complete(new Uint8Array(31));
      await flush();
      expect(FakeXhr.sends).toHaveLength(0);
      expect(settled).toHaveBeenCalledOnce();
      expect(settled).toHaveBeenCalledWith({
        status: 0,
        responseText: "",
        stalled: false,
      });
      expect(pending.size).toBe(0);
      transfer.dispose();
    },
  );

  it("never retries a failed request, not even when another upload starts", async () => {
    const { timers } = manualTimers();
    const transfer = createUppyTransfer(2, timers);
    const failed = vi.fn();
    transfer.start(request("2"), { onProgress: vi.fn(), onSettled: failed });
    await flush();
    FakeXhr.sends[0]!.fail();
    await flush();
    await vi.advanceTimersByTimeAsync(700);
    expect(failed).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0]![0]).toMatchObject({
      status: 0,
      stalled: false,
    });
    expect(FakeXhr.sends).toHaveLength(1);

    const serverError = vi.fn();
    transfer.start(request("3"), {
      onProgress: vi.fn(),
      onSettled: serverError,
    });
    await flush();
    expect(FakeXhr.sends).toHaveLength(2);
    expect(FakeXhr.sends[1]!.url).toContain("0003");
    FakeXhr.sends[1]!.answer(503, "");
    await flush();
    await vi.advanceTimersByTimeAsync(700);
    expect(serverError).toHaveBeenCalledWith({
      status: 503,
      responseText: "",
      stalled: false,
    });
    expect(FakeXhr.sends).toHaveLength(2);
    transfer.dispose();
  });

  it("aborts without reporting and ends a stalled transfer as a failure", async () => {
    const { timers, fire } = manualTimers();
    const transfer = createUppyTransfer(2, timers);
    const aborted = vi.fn();
    transfer.start(request("4"), { onProgress: vi.fn(), onSettled: aborted });
    await flush();
    transfer.abort("4");
    await flush();
    expect(FakeXhr.sends[0]!.aborted).toBe(true);
    expect(aborted).not.toHaveBeenCalled();

    const stalled = vi.fn();
    transfer.start(request("5"), { onProgress: vi.fn(), onSettled: stalled });
    await flush();
    fire(TRANSFER_TIMING.stallMs);
    await flush();
    expect(stalled).toHaveBeenCalledWith({
      status: 0,
      responseText: "",
      stalled: true,
    });
    expect(FakeXhr.sends[1]!.aborted).toBe(true);
    expect(FakeXhr.sends).toHaveLength(2);
    transfer.dispose();
  });
});
