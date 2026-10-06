import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";

export const HOME_PHASES = [
  "init",
  "seed.begin",
  "seed.baseline",
  "initial.before",
  "initial.after",
  "restore.before",
  "matcher",
  "restore.matched",
  "settings.before",
  "settings.after",
  "destination.before",
  "destination.after",
  "final.before",
  "final.after",
  "end",
] as const;
export type HomePhase = (typeof HOME_PHASES)[number];
export type HomeDiagnosticFeed =
  "discover" | "nearby" | "inscriptions" | "calligraphy";
export type HomeSnapshot = {
  schema: 1;
  documentLabel: number[];
  rows: (number | boolean | null)[][];
  slots: { key: string; samples: number; retained: number }[];
  seen: number;
  invalid: number;
  slotOverflow: number;
  attribution: {
    schema: 1;
    rows: (number | boolean | null)[][];
    seen: number;
    invalid: number;
    first900ToZero: number | null;
  };
};

type BrowserRecorder = {
  bind: (
    phase: HomePhase,
    feed: HomeDiagnosticFeed,
    iteration: number,
    expected: number | null,
  ) => void;
  mark: (tag: number, node?: HTMLElement, expected?: number) => void;
  writer: (
    actor: number,
    edge: number,
    node: HTMLElement,
    intended: number,
  ) => void;
  snapshot: () => HomeSnapshot;
};
declare global {
  interface Window {
    __artvennHomeRecorder?: BrowserRecorder;
  }
}
let latest: HomeSnapshot | null = null;
let writeReturns: number[][] = [];
let documentChanges = 0;
export const rememberHomeWriteReturn = (
  feed: HomeDiagnosticFeed,
  top: number,
) => {
  if (process.env.MOYA_HOME_DIAGNOSTIC_DIR)
    writeReturns.push([
      ["discover", "nearby", "inscriptions", "calligraphy"].indexOf(feed),
      top,
      ...(latest?.documentLabel ?? [0, 0]),
    ]);
};
export const rememberHomeSnapshot = (snapshot: HomeSnapshot | undefined) => {
  if (snapshot !== undefined) {
    if (
      latest &&
      JSON.stringify(latest.documentLabel) !==
        JSON.stringify(snapshot.documentLabel)
    )
      documentChanges += 1;
    latest = snapshot;
  }
};

// Runs only in the selected disposable browser. No URLs, text, storage or network data.
export function installHomeRecorder() {
  const phases = [
    "init",
    "seed.begin",
    "seed.baseline",
    "initial.before",
    "initial.after",
    "restore.before",
    "matcher",
    "restore.matched",
    "settings.before",
    "settings.after",
    "destination.before",
    "destination.after",
    "final.before",
    "final.after",
    "end",
  ];
  const feeds = ["discover", "nearby", "inscriptions", "calligraphy"];
  const documentLabel = Array.from(crypto.getRandomValues(new Uint32Array(2)));
  const ids = new WeakMap<Element, number>();
  let next = 1;
  const id = (node: Element | null) => {
    if (node === null) return null;
    let value = ids.get(node);
    if (value === undefined) {
      value = next++;
      ids.set(node, value);
    }
    return value;
  };
  type Row = (number | boolean | null)[];
  const slots = new Map<
    string,
    { first: Row; last: Row; divergence: Row | null; samples: number }
  >();
  let context = {
    phase: 0,
    feed: 0,
    iteration: 0,
    expected: null as number | null,
  };
  let attributionSeen = 0;
  let attributionInvalid = 0;
  let previousTop: number | null = null;
  let first900ToZero: number | null = null;
  const attributionFirst: Row[] = [];
  const attributionRecent: Row[] = [];
  const attributionFailure: Row[] = [];
  let afterFailure = 0;
  const attribute = (
    kind: number,
    actor: number,
    edge: number,
    panel: HTMLElement,
    intended: number | null,
    tag: number,
    trusted: boolean | null = null,
  ) => {
    // Only the implicated first Discover seed-to-baseline window is eligible.
    if (context.phase !== 1 || context.feed !== 0 || context.iteration !== 0)
      return;
    if (panel.dataset.homeFeedPanel !== "discover") return;
    const home = panel.closest<HTMLElement>("[data-home-surface]");
    if (home === null) return;
    const active = feeds.indexOf(home.dataset.activeHomeFeed ?? "");
    const activePanel =
      active < 0
        ? null
        : home.querySelector<HTMLElement>(
            `[data-home-feed-panel="${feeds[active]}"]`,
          );
    const row: Row = [
      attributionSeen + 1,
      Math.round(performance.now() * 1000) / 1000,
      kind,
      actor,
      edge,
      tag,
      context.phase,
      context.iteration,
      context.feed,
      id(panel),
      id(activePanel),
      active < 0 ? null : active,
      context.expected,
      intended,
      panel.scrollTop,
      panel.scrollHeight,
      panel.clientHeight,
      Math.max(0, panel.scrollHeight - panel.clientHeight),
      trusted,
    ];
    if (
      row.some(
        (value) =>
          value !== null &&
          typeof value !== "boolean" &&
          (typeof value !== "number" || !Number.isFinite(value)),
      )
    ) {
      attributionInvalid += 1;
      return;
    }
    attributionSeen += 1;
    if (attributionFirst.length < 12) attributionFirst.push(row);
    if (first900ToZero === null && previousTop === 900 && row[14] === 0) {
      first900ToZero = attributionSeen;
      attributionFailure.push(...attributionRecent, row);
      afterFailure = 12;
    } else if (afterFailure > 0) {
      attributionFailure.push(row);
      afterFailure -= 1;
    }
    previousTop = panel.scrollTop;
    attributionRecent.push(row);
    if (attributionRecent.length > 12) attributionRecent.shift();
  };
  let seen = 0;
  let invalid = 0;
  let slotOverflow = 0;
  let observed: HTMLElement | null = null;
  let observer: MutationObserver | null = null;
  const allowedContext = (phase: number, feed: number, iteration: number) => {
    if (phase === 0) return feed === 0 && iteration === 0;
    if ([1, 2, 12, 13].includes(phase)) return [0, 1, 3][iteration] === feed;
    if ([3, 4].includes(phase)) return feed === 0 && iteration === 0;
    if ([5, 6, 7].includes(phase)) return [3, 1, 0, 3][iteration] === feed;
    return [8, 9, 10, 11, 14].includes(phase) && feed === 3 && iteration === 0;
  };
  const mark = (tag: number, target?: HTMLElement, expected?: number) => {
    const home =
      target?.closest<HTMLElement>("[data-home-surface]") ??
      (observed?.isConnected
        ? observed
        : document.querySelector<HTMLElement>("[data-home-surface]"));
    if (home === null) return;
    if (observed !== home) {
      observer?.disconnect();
      observed = home;
      observer = new MutationObserver(() => mark(4));
      observer.observe(home, {
        attributes: true,
        attributeFilter: ["data-active-home-feed"],
      });
    }
    const panels = target?.hasAttribute("data-home-feed-panel")
      ? [target]
      : Array.from(
          home.querySelectorAll<HTMLElement>("[data-home-feed-panel]"),
        );
    const active = feeds.indexOf(home.dataset.activeHomeFeed ?? "");
    const activePanel =
      active < 0
        ? null
        : home.querySelector<HTMLElement>(
            `[data-home-feed-panel="${feeds[active]}"]`,
          );
    for (const panel of panels) {
      attribute(2, 2, 2, panel, expected ?? context.expected, tag);
      const feed = feeds.indexOf(panel.dataset.homeFeedPanel ?? "");
      if (
        feed < 0 ||
        !allowedContext(context.phase, context.feed, context.iteration)
      ) {
        invalid += 1;
        continue;
      }
      const pager = home.querySelector<HTMLElement>("[data-home-feed-pager]");
      const outer = home.closest<HTMLElement>(
        '[data-primary-destination="home"]',
      );
      const masonry = panel.querySelector<HTMLElement>("[data-home-masonry]");
      const row: Row = [
        ++seen,
        performance.now(),
        context.phase,
        tag,
        context.iteration,
        context.feed,
        feed,
        expected ?? (feed === context.feed ? context.expected : null),
        id(panel),
        id(home),
        id(pager),
        id(outer),
        id(masonry),
        active < 0 ? null : active,
        panel.scrollTop,
        panel.scrollHeight,
        panel.clientHeight,
        Math.max(0, panel.scrollHeight - panel.clientHeight),
        pager?.scrollLeft ?? null,
        outer?.scrollTop ?? null,
        masonry?.dataset.layoutReady === "true",
        masonry?.hasAttribute("data-layout-retained") ?? false,
        panel.dataset.testScrollIdentity === `stable-${feeds[feed]}`,
        panel.isConnected,
        id(activePanel),
        activePanel?.scrollTop ?? null,
      ];
      const key = `${context.phase}.${context.iteration}.${context.feed}.${feed}`;
      const slot = slots.get(key);
      if (slot === undefined) {
        if (slots.size >= 128) {
          slotOverflow += 1;
          continue;
        }
        slots.set(key, { first: row, last: row, divergence: null, samples: 1 });
      } else {
        slot.samples += 1;
        if (
          slot.divergence === null &&
          (row[8] !== slot.first[8] || row[14] !== slot.first[14])
        )
          slot.divergence = row;
        slot.last = row;
      }
    }
  };
  window.__artvennHomeRecorder = {
    bind: (phase, feed, iteration, expected) => {
      context = {
        phase: phases.indexOf(phase),
        feed: feeds.indexOf(feed),
        iteration,
        expected,
      };
    },
    mark,
    writer: (actor, edge, panel, intended) => {
      if (
        ![0, 1].includes(actor) ||
        ![0, 1].includes(edge) ||
        !Number.isFinite(intended)
      ) {
        attributionInvalid += 1;
        return;
      }
      attribute(0, actor, edge, panel, intended, 0);
    },
    snapshot: () => {
      const rows: Row[] = [];
      const counts: { key: string; samples: number; retained: number }[] = [];
      for (const [key, slot] of slots) {
        const kept = [slot.first, slot.divergence, slot.last].filter(
          (row): row is Row => row !== null,
        );
        const unique = [...new Map(kept.map((row) => [row[0], row])).values()];
        rows.push(...unique);
        counts.push({ key, samples: slot.samples, retained: unique.length });
      }
      return {
        schema: 1,
        documentLabel,
        rows: rows.sort((a, b) => Number(a[0]) - Number(b[0])),
        slots: counts,
        seen,
        invalid,
        slotOverflow,
        attribution: {
          schema: 1,
          rows: [
            ...new Map(
              [
                ...attributionFirst,
                ...attributionFailure,
                ...attributionRecent,
              ].map((row) => [row[0], row]),
            ).values(),
          ].sort((a, b) => Number(a[0]) - Number(b[0])),
          seen: attributionSeen,
          invalid: attributionInvalid,
          first900ToZero,
        },
      };
    },
  };
  document.addEventListener(
    "scroll",
    (event) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.hasAttribute("data-home-feed-panel")
      ) {
        attribute(1, 2, 2, event.target, null, 3, event.isTrusted);
        mark(3, event.target);
      }
    },
    { capture: true, passive: true },
  );
  window.addEventListener("__artvennHomeWrite", (event) => {
    if (
      !(event instanceof CustomEvent) ||
      !Array.isArray(event.detail) ||
      event.detail.length !== 4
    )
      return;
    const [actor, edge, panel, intended] = event.detail;
    if (
      !(panel instanceof HTMLElement) ||
      !panel.hasAttribute("data-home-feed-panel")
    )
      return;
    window.__artvennHomeRecorder?.writer(actor, edge, panel, intended);
  });
}

export async function startHomeDiagnostic(page: Page, info: TestInfo) {
  if (!process.env.MOYA_HOME_DIAGNOSTIC_DIR) return undefined;
  latest = null;
  writeReturns = [];
  documentChanges = 0;
  await page.addInitScript(installHomeRecorder);
  return {
    async checkpoint(
      home: Locator,
      phase: HomePhase,
      feed: HomeDiagnosticFeed,
      iteration: number,
      expected: number | null = null,
    ) {
      rememberHomeSnapshot(
        await home.evaluate(
          (node, input) => {
            const recorder = window.__artvennHomeRecorder;
            recorder?.bind(
              input.phase,
              input.feed,
              input.iteration,
              input.expected,
            );
            recorder?.mark(0, node as HTMLElement);
            return recorder?.snapshot();
          },
          { phase, feed, iteration, expected },
        ),
      );
    },
    async finish() {
      let finalSnapshot = false;
      try {
        rememberHomeSnapshot(
          await page.evaluate(() => window.__artvennHomeRecorder?.snapshot()),
        );
        finalSnapshot = true;
      } catch {
        /* Last same-attempt Node snapshot remains available. */
      }
      const body = JSON.stringify({
        schema: 1,
        project: info.project.name,
        retry: info.retry,
        finalSnapshot,
        documentChanges,
        writeReturns,
        snapshot: latest,
      });
      if (Buffer.byteLength(body) > 131072)
        throw new Error("Home diagnostic packet bound exceeded");
      writeFileSync(
        resolve(
          process.env.MOYA_HOME_DIAGNOSTIC_DIR!,
          `retry-${info.retry}.json`,
        ),
        body,
        { mode: 0o600 },
      );
    },
  };
}
