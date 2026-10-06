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
};

type BrowserRecorder = {
  bind: (
    phase: HomePhase,
    feed: HomeDiagnosticFeed,
    iteration: number,
    expected: number | null,
  ) => void;
  mark: (tag: number, node?: HTMLElement, expected?: number) => void;
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
      };
    },
  };
  document.addEventListener(
    "scroll",
    (event) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.hasAttribute("data-home-feed-panel")
      )
        mark(3, event.target);
    },
    { capture: true, passive: true },
  );
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
