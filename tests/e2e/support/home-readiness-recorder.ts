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
  evaluationTimes: Scalar[];
  lastEvaluation: [number, number, number | null] | null;
};
type PhaseFrame = [number, number, number, number, number, number, number];
type BrowserPhases = {
  schema: number;
  elapsed_ticks: number;
  queue_ticks: number;
  continuation_ticks: number;
  geometry_ticks: number;
  other_ticks: number;
  seen: number;
  omitted: number;
  roles: [number, number, number];
  rows: PhaseFrame[];
};
function acceptAlignmentPhases(
  value: unknown,
  frames: number,
  elapsedMs: number,
): BrowserPhases | undefined {
  try {
    const p = value as BrowserPhases;
    const keys = [
      "schema",
      "elapsed_ticks",
      "queue_ticks",
      "continuation_ticks",
      "geometry_ticks",
      "other_ticks",
      "seen",
      "omitted",
      "roles",
      "rows",
    ];
    const tick = (x: unknown) =>
      typeof x === "number" &&
      Number.isSafeInteger(x) &&
      x >= 0 &&
      x <= 108000000;
    if (
      !p ||
      typeof p !== "object" ||
      Object.keys(p).sort().join(",") !== keys.sort().join(",") ||
      p.schema !== 1 ||
      p.seen !== frames ||
      !Number.isInteger(p.seen) ||
      p.seen < 0 ||
      p.seen > 100000 ||
      !tick(p.elapsed_ticks) ||
      Math.abs(p.elapsed_ticks - Math.round(elapsedMs * 100)) > 1 ||
      ![
        p.queue_ticks,
        p.continuation_ticks,
        p.geometry_ticks,
        p.other_ticks,
      ].every(tick) ||
      p.queue_ticks +
        p.continuation_ticks +
        p.geometry_ticks +
        p.other_ticks !==
        p.elapsed_ticks ||
      !Array.isArray(p.rows) ||
      p.rows.length > 3 ||
      p.omitted !== p.seen - p.rows.length ||
      !Array.isArray(p.roles) ||
      p.roles.length !== 3 ||
      p.roles.some((x) => !Number.isInteger(x) || x < 0 || x > p.seen)
    )
      throw new Error("ALIGNMENT_PHASE_SCHEMA_REJECTED");
    let previous = 0,
      previousEnd = 0,
      queue = 0,
      continuation = 0,
      geometry = 0;
    const rows = p.rows.map((row) => {
      if (
        !Array.isArray(row) ||
        row.length !== 7 ||
        !Number.isInteger(row[0]) ||
        row[0] <= previous ||
        row[0] > p.seen ||
        !row.slice(1, 5).every(tick) ||
        row[1] < previousEnd ||
        row[1] > row[2] ||
        row[2] > row[3] ||
        row[3] > row[4] ||
        row[4] > p.elapsed_ticks ||
        ![0, 1, 2, 3].includes(row[5]) ||
        ![0, 1, 2, 3].includes(row[6])
      )
        throw new Error("ALIGNMENT_PHASE_FRAME_REJECTED");
      previous = row[0];
      previousEnd = row[4];
      queue += row[2] - row[1];
      continuation += row[3] - row[2];
      geometry += row[4] - row[3];
      return [...row] as PhaseFrame;
    });
    if (
      p.seen === 0 &&
      p.queue_ticks + p.continuation_ticks + p.geometry_ticks !== 0
    )
      throw new Error("ALIGNMENT_PHASE_EMPTY_REJECTED");
    const roleSet = new Set(p.roles.filter((x) => x !== 0));
    const slow = rows.find((row) => row[0] === p.roles[2]);
    if (
      rows.length !== roleSet.size ||
      rows.some((row) => !roleSet.has(row[0])) ||
      (p.seen === 0
        ? p.roles.some((x) => x !== 0) || rows.length !== 0
        : p.roles[0] !== 1 ||
          p.roles[1] !== p.seen ||
          !slow ||
          rows.some((row) => row[4] - row[1] > slow[4] - slow[1])) ||
      queue > p.queue_ticks ||
      continuation > p.continuation_ticks ||
      geometry > p.geometry_ticks
    )
      throw new Error("ALIGNMENT_PHASE_RETENTION_REJECTED");
    return {
      schema: 1,
      elapsed_ticks: p.elapsed_ticks,
      queue_ticks: p.queue_ticks,
      continuation_ticks: p.continuation_ticks,
      geometry_ticks: p.geometry_ticks,
      other_ticks: p.other_ticks,
      seen: p.seen,
      omitted: p.omitted,
      roles: [...p.roles],
      rows,
    };
  } catch {
    return undefined;
  }
}

type Touch = {
  phase: number;
  feed: number;
  begin: number;
  end: number | null;
  rows: Row[];
  phaseRecords: ({ hop: number } & BrowserPhases)[];
  pending: { kind: number; row: Row } | null;
};
const touchRoutes = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
  [0, 3],
  [1, 3],
  [1, 0],
  [1, 3],
  [1, 1],
  [1, 0],
  [1, 3],
  [2, 0],
  [2, 1],
  [2, 3],
];
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
  private touches: Touch[] = [];
  private touchInvalid = 0;
  private touchOverflow = 0;

  private stamp() {
    return performance.now() - this.started;
  }
  touchBegin(feed: string) {
    const route = touchRoutes[this.touches.length];
    if (!route) {
      this.touchOverflow += 1;
      return undefined;
    }
    if (route[0] !== this.currentPhase || route[1] !== feeds.indexOf(feed)) {
      this.touchInvalid += 1;
      return undefined;
    }
    this.touches.push({
      phase: this.currentPhase,
      feed: route[1],
      begin: this.stamp(),
      end: null,
      rows: [],
      phaseRecords: [],
      pending: null,
    });
    return this.touches.length;
  }
  touchOpBegin(call: number | undefined, kind: number, feed: string) {
    const touch = call === undefined ? undefined : this.touches[call - 1];
    if (!touch) return;
    const target = feeds.indexOf(feed);
    if (
      touch.end !== null ||
      touch.pending ||
      target < 0 ||
      ![0, 1, 2, 3].includes(kind)
    ) {
      this.touchInvalid += 1;
      return;
    }
    let row = touch.rows.at(-1);
    if (kind === 0 || kind === 1) {
      if (
        (kind === 0 && touch.rows.length !== 0) ||
        (kind === 1 &&
          (!row || row[9] !== 1 || Math.abs(Number(row[2]) - target) !== 1))
      ) {
        this.touchInvalid += 1;
        return;
      }
      if (touch.rows.length >= 4) {
        this.touchOverflow += 1;
        return;
      }
      row = [
        call!,
        touch.rows.length,
        target,
        null,
        null,
        null,
        null,
        null,
        null,
        0,
        null,
        null,
        null,
        null,
      ];
      touch.rows.push(row);
    } else if (
      !row ||
      row[1] === 0 ||
      row[2] !== target ||
      (kind === 2
        ? row[4] === null || row[5] !== null
        : row[6] === null || row[7] !== null)
    ) {
      this.touchInvalid += 1;
      return;
    }
    const at = kind === 1 ? 3 : kind === 2 ? 5 : 7;
    row![at] = this.stamp();
    touch.pending = { kind, row: row! };
  }
  touchOpEnd(call: number | undefined, kind: number) {
    const touch = call === undefined ? undefined : this.touches[call - 1];
    if (!touch) return;
    if (!touch.pending || touch.pending.kind !== kind) {
      this.touchInvalid += 1;
      return;
    }
    const at = kind === 1 ? 4 : kind === 2 ? 6 : 8;
    touch.pending.row[at] = this.stamp();
    if (kind === 0 || kind === 3) touch.pending.row[9] = 1;
    touch.pending = null;
  }
  touchEnd(call: number | undefined) {
    const touch = call === undefined ? undefined : this.touches[call - 1];
    if (!touch) return;
    if (touch.pending || touch.end !== null || touch.rows.at(-1)?.[9] !== 1) {
      this.touchInvalid += 1;
      return;
    }
    touch.end = this.stamp();
  }
  alignmentToken() {
    const touch = this.touches.at(-1);
    return touch?.pending && [0, 3].includes(touch.pending.kind)
      ? { call: this.touches.length, hop: Number(touch.pending.row[1]) }
      : undefined;
  }
  alignmentResult(token: { call: number; hop: number }, value: unknown) {
    const touch = this.touches[token.call - 1],
      row = touch?.pending?.row;
    const v = value as {
      frames?: unknown;
      elapsed_ms?: unknown;
      aligned?: unknown;
      gap?: unknown;
      phases?: unknown;
    } | null;
    if (
      !row ||
      row[1] !== token.hop ||
      !v ||
      !Number.isInteger(v.frames) ||
      Number(v.frames) < 0 ||
      Number(v.frames) > 100000 ||
      finite(v.elapsed_ms) === null ||
      Number(v.elapsed_ms) < 0 ||
      Number(v.elapsed_ms) > 1080000 ||
      typeof v.aligned !== "boolean" ||
      (v.gap !== null && finite(v.gap) === null) ||
      (typeof v.gap === "number" && (v.gap < 0 || v.gap > 10000000))
    ) {
      this.touchInvalid += 1;
      return;
    }
    const phases = acceptAlignmentPhases(
      v.phases,
      Number(v.frames),
      Number(v.elapsed_ms),
    );
    if (
      !phases ||
      touch.phaseRecords.some((entry) => entry.hop === token.hop)
    ) {
      this.touchInvalid += 1;
      return;
    }
    touch.phaseRecords.push({ hop: token.hop, ...phases });
    row[10] = Number(v.frames);
    row[11] = Number(v.elapsed_ms);
    row[12] = v.aligned;
    row[13] = finite(v.gap);
  }
  evaluationBegin(call: number | undefined, kind: number) {
    const slot = call === undefined ? undefined : this.slots[call - 1];
    if (!slot) return;
    if (
      ![0, 1].includes(kind) ||
      (slot.lastEvaluation && slot.lastEvaluation[2] === null) ||
      (kind === 1 && slot.evaluationTimes[1] === null)
    ) {
      this.invalid += 1;
      return;
    }
    const at = this.stamp();
    if (kind === 0) slot.evaluationTimes = [at, null, null, null];
    else slot.evaluationTimes[2] = at;
    slot.lastEvaluation = [kind, at, null];
  }
  evaluationEnd(call: number | undefined, kind: number) {
    const slot = call === undefined ? undefined : this.slots[call - 1];
    if (!slot) return;
    if (
      !slot.lastEvaluation ||
      slot.lastEvaluation[0] !== kind ||
      slot.lastEvaluation[2] !== null
    ) {
      this.invalid += 1;
      return;
    }
    const at = this.stamp();
    slot.lastEvaluation[2] = at;
    slot.evaluationTimes[kind === 0 ? 1 : 3] = at;
  }

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
      evaluationTimes: [null, null, null, null],
      lastEvaluation: null,
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
      ...Array<null>(20).fill(null),
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
        ...slot.evaluationTimes,
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
        last_evaluation: slot.lastEvaluation ? [...slot.lastEvaluation] : null,
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
      touches: {
        calls: this.touches.map((touch, index) => ({
          call: index + 1,
          phase: touch.phase,
          feed: touch.feed,
          begin_ms: touch.begin,
          end_ms: touch.end,
          completed: touch.end !== null,
          rows: touch.rows.map((row) =>
            row[9] === 1
              ? [...row]
              : row.map((x, at) =>
                  at === 9
                    ? nativeStatus === "timedOut"
                      ? 3
                      : nativeErrorPresent
                        ? 2
                        : 0
                    : x,
                ),
          ),
          pending_kind: touch.pending?.kind ?? null,
          phase_records: touch.phaseRecords.map((entry) => ({
            ...entry,
            roles: [...entry.roles],
            rows: entry.rows.map((row) => [...row]),
          })),
        })),
        invalid: this.touchInvalid,
        overflow: this.touchOverflow,
      },
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
let activeHomeReadiness: HomeReadinessRecorder | undefined;
export function beginHomeAlignment() {
  const recorder = activeHomeReadiness,
    token = recorder?.alignmentToken();
  return recorder && token ? { recorder, token } : undefined;
}
export function finishHomeAlignment(
  context: ReturnType<typeof beginHomeAlignment>,
  value: unknown,
) {
  context?.recorder.alignmentResult(context.token, value);
}
export function startHomeReadiness() {
  activeHomeReadiness = process.env.MOYA_HOME_DIAGNOSTIC_DIR
    ? new HomeReadinessRecorder()
    : undefined;
  return activeHomeReadiness;
}
