import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import type { TestInfo } from "@playwright/test";

type Scalar = number | boolean | null;
type Row = Scalar[];
type Evidence = Record<string, unknown> & {
  activeFeed: string | null;
  layoutReady: string | null;
  layoutRetained: boolean;
  mediaTerminal: boolean;
  masonryHeightMinusMaxItemBottom: number | null;
  images: { complete: boolean; naturalWidth: number }[];
};
type Slot = {
  phase: number;
  feed: number;
  seen: number;
  first: Row[];
  last: Row[];
  failure: Row | null;
  failureBefore: Row | null;
  change: Row | null;
  changeBefore: Row | null;
  terminal: Row | null;
  previous: Evidence | null;
};
const feeds = ["discover", "nearby", "inscriptions", "calligraphy"];
const routes = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
  [0, 3],
  [1, 3],
  [2, 0],
  [2, 1],
  [2, 3],
];
const signatureKeys = [
  "activeFeed",
  "anchorX",
  "anchorY",
  "images",
  "items",
  "layoutReady",
  "layoutRetained",
  "masonryColumns",
  "masonryHeight",
  "masonryHeightMinusMaxItemBottom",
  "masonryWidth",
  "mediaStates",
  "scrollTop",
];
const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export class HomeReadinessRecorder {
  private started = performance.now();
  private wallStarted = Date.now();
  private currentPhase = 0;
  private slots: Slot[] = [];
  private seen = 0;
  private invalid = 0;
  private overflow = 0;
  private actions: [number, number, number | null, number][] = [];
  private actionInvalid = 0;
  private actionOverflow = 0;

  actionBegin(group: number) {
    if (this.actions.length >= 9) {
      this.actionOverflow += 1;
      return;
    }
    if (
      !Number.isInteger(group) ||
      group !== this.actions.length ||
      (this.actions.length > 0 && this.actions.at(-1)![2] === null)
    ) {
      this.actionInvalid += 1;
      return;
    }
    this.actions.push([group, performance.now() - this.started, null, 0]);
  }
  actionEnd(group: number) {
    const row = this.actions.at(-1);
    if (!row || row[0] !== group || row[2] !== null) {
      this.actionInvalid += 1;
      return;
    }
    row[2] = performance.now() - this.started;
    row[3] = 1;
  }
  finalSettleBegin(feed: string) {
    if (this.currentPhase === 2 && feed === "discover") this.actionBegin(8);
  }
  finalSettleEnd(feed: string) {
    if (this.currentPhase === 2 && feed === "discover") this.actionEnd(8);
  }

  phase(value: number) {
    if ([0, 1, 2].includes(value)) this.currentPhase = value;
    else this.invalid += 1;
  }
  begin(feed: string) {
    const index = feeds.indexOf(feed);
    const route = routes[this.slots.length];
    if (!route) {
      this.overflow += 1;
      return undefined;
    }
    if (route[0] !== this.currentPhase || route[1] !== index) {
      this.invalid += 1;
      return undefined;
    }
    const slot: Slot = {
      phase: this.currentPhase,
      feed: index,
      seen: 0,
      first: [],
      last: [],
      failure: null,
      failureBefore: null,
      change: null,
      changeBefore: null,
      terminal: null,
      previous: null,
    };
    this.slots.push(slot);
    const call = this.slots.length;
    this.event(call, 0);
    return call;
  }
  eagerDone(call: number | undefined) {
    this.event(call, 1);
  }
  settled(call: number | undefined) {
    this.event(call, 3);
  }
  private keep(slot: Slot, row: Row) {
    slot.seen += 1;
    if (slot.first.length < 2) slot.first.push(row);
    slot.last.push(row);
    if (slot.last.length > 2) slot.last.shift();
  }
  private event(call: number | undefined, event: number) {
    const slot = call === undefined ? undefined : this.slots[call - 1];
    if (!slot) return;
    if (slot.terminal !== null) {
      this.invalid += 1;
      return;
    }
    const row: Row = [
      ++this.seen,
      performance.now() - this.started,
      call!,
      slot.phase,
      slot.feed,
      event,
      ...Array<null>(16).fill(null),
    ];
    this.keep(slot, row);
    if (event === 3) slot.terminal = row;
  }
  sample(
    call: number | undefined,
    value: Evidence,
    stable: number,
    same: boolean,
  ) {
    const slot = call === undefined ? undefined : this.slots[call - 1];
    if (!slot) return;
    if (slot.terminal !== null) {
      this.invalid += 1;
      return;
    }
    try {
      const active = feeds.indexOf(value.activeFeed ?? "");
      const geometry =
        value.masonryHeightMinusMaxItemBottom !== null &&
        Math.abs(value.masonryHeightMinusMaxItemBottom) <= 2;
      const loaded = value.images.filter(
        (i) => i.complete && i.naturalWidth > 0,
      ).length;
      const pending = value.images.filter((i) => !i.complete).length;
      const failed = value.images.filter(
        (i) => i.complete && !(i.naturalWidth > 0),
      ).length;
      let changed = 0;
      if (slot.previous)
        for (const [bit, key] of signatureKeys.entries())
          if (JSON.stringify(slot.previous[key]) !== JSON.stringify(value[key]))
            changed |= 1 << bit;
      const ready =
        active === slot.feed &&
        value.layoutReady === "true" &&
        !value.layoutRetained &&
        value.mediaTerminal &&
        geometry;
      const row: Row = [
        ++this.seen,
        performance.now() - this.started,
        call!,
        slot.phase,
        slot.feed,
        2,
        active < 0 ? null : active,
        value.layoutReady === "true",
        value.layoutRetained,
        value.images.length,
        loaded,
        pending,
        failed,
        value.mediaTerminal,
        geometry,
        finite(value.masonryHeightMinusMaxItemBottom),
        stable,
        slot.previous === null ? null : same,
        changed,
        ready,
        finite(value.scrollTop),
        finite(value.clientHeight),
      ];
      const before = slot.last.at(-1) ?? null;
      this.keep(slot, row);
      if (!ready && slot.failure === null) {
        slot.failure = row;
        slot.failureBefore = before;
      }
      if (changed && slot.change === null) {
        slot.change = row;
        slot.changeBefore = before;
      }
      slot.previous = value;
    } catch {
      this.invalid += 1;
    }
  }
  snapshot(nativeStatus?: string, nativeErrorPresent = false) {
    const rows: Row[] = [];
    const slots = this.slots.map((slot, index) => {
      const kept = [
        ...slot.first,
        slot.failureBefore,
        slot.failure,
        slot.changeBefore,
        slot.change,
        slot.terminal,
        ...slot.last,
      ].filter((row): row is Row => row !== null);
      const unique = [...new Map(kept.map((row) => [row[0], row])).values()];
      rows.push(...unique);
      return {
        call: index + 1,
        phase: slot.phase,
        feed: slot.feed,
        seen: slot.seen,
        retained: unique.length,
        completed: slot.terminal !== null,
        omitted: slot.seen - unique.length,
      };
    });
    return {
      schema: 1,
      body_started_epoch_ms: this.wallStarted,
      rows: rows.sort((a, b) => Number(a[0]) - Number(b[0])),
      slots,
      seen: this.seen,
      invalid: this.invalid,
      overflow: this.overflow,
      actions: {
        rows: this.actions.map((row) =>
          row[2] !== null
            ? [...row]
            : [
                row[0],
                row[1],
                null,
                nativeStatus === "timedOut" ? 3 : nativeErrorPresent ? 2 : 0,
              ],
        ),
        invalid: this.actionInvalid,
        overflow: this.actionOverflow,
      },
    };
  }
  finish(info: TestInfo) {
    const directory = process.env.MOYA_HOME_DIAGNOSTIC_DIR;
    if (!directory) return;
    try {
      const body = JSON.stringify({
        schema: 1,
        project: info.project.name,
        retry: info.retry,
        readiness: this.snapshot(info.status, info.errors.length > 0),
      });
      if (Buffer.byteLength(body) > 131072) return;
      writeFileSync(resolve(directory, `retry-${info.retry}.json`), body, {
        mode: 0o600,
      });
    } catch {
      /* Missing capture is reported by the coordinator; never alter the native result. */
    }
  }
}
export function startHomeReadiness() {
  return process.env.MOYA_HOME_DIAGNOSTIC_DIR
    ? new HomeReadinessRecorder()
    : undefined;
}
