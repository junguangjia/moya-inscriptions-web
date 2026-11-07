import { resolveCatalogCollection } from "../../features/topics/topic";
import { homeScenarioNames } from "../../features/qa/home-scenario-contract";
import { createTimelineFixture } from "./timeline-fixture";

import type { CatalogSummary, MediaId, PublicMedia } from "@moya/contracts";
import type {
  HomeFeedState,
  HomeSurfaceData,
} from "../../features/home/home-feed";
import type {
  DevelopmentHomeScenario,
  HomeScenarioName,
} from "../../features/qa/home-scenario-contract";
import type {
  CatalogCollectionDefinition,
  EditorialTopic,
  Topic,
} from "../../features/topics/topic";

export { homeScenarioNames };
export type {
  DevelopmentHomeScenario,
  DevelopmentHomeScenarios,
  HomeScenarioName,
} from "../../features/qa/home-scenario-contract";

const normalizeOrigin = (mediaOrigin: string) => {
  const origin = new URL(mediaOrigin);
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new TypeError("Development Home media origin must use HTTP(S)");
  }
  return origin.origin;
};

const demoMedia = (
  origin: string,
  fileName: string,
  id: string,
  alt: string,
  width: number,
  height: number,
): PublicMedia => ({
  alt,
  height,
  id: id as MediaId,
  kind: "image",
  src: new URL(`/docs/design-system/assets/demo/${fileName}`, origin).href,
  width,
});

const editorialTopics = (origin: string): readonly EditorialTopic[] => [
  {
    blurb: "沿着山壁阅读石刻与题名的策展短篇。",
    blocks: [
      {
        text: "本专题以虚构条目呈现策展阅读气质，不代表真实著录。阅读从山门与谷壁之间缓慢展开，先辨认石面、光线与路径，再留意文字如何进入地方景观。",
        type: "lead",
      },
      {
        media: demoMedia(
          origin,
          "valley-wall.svg",
          "topic-cliff-paths-image",
          "虚构山谷摩崖图",
          360,
          430,
        ),
        caption: "山壁上的题记往往随光线与视角变化。",
        type: "image",
      },
      {
        text: "正式产品中的内容模型、发布主体与数据边界另行决定；这里不代表用户帖或生产 CMS。当前段落只用于检验较长策展正文在手机、平板与桌面阅读宽度中的换行、节奏和滚动，不为虚构地点补充任何真实史实。",
        type: "rich-text",
      },
      { text: "志于道，据于德，依于仁，游于艺。", type: "quote" },
      { caption: "视频占位（无真实文件，不自动播放）", type: "video" },
    ],
    cover: demoMedia(
      origin,
      "cliff-gate.svg",
      "topic-cliff-paths-cover",
      "虚构摩崖山门图",
      360,
      520,
    ),
    id: "topic-cliff-paths",
    kind: "editorialTopic",
    title: "摩崖之路",
  },
  {
    blurb: "从拓片肌理到墨色层次的阅读提示。",
    blocks: [
      { text: "拓片是纸、墨与石面之间留下的痕迹。", type: "lead" },
      {
        media: demoMedia(
          origin,
          "inscription-rubbing.svg",
          "topic-rubbing-image",
          "虚构碑刻拓本图",
          600,
          420,
        ),
        caption: "演示图：拓本局部。",
        type: "image",
      },
      { text: "这里只提供轻量策展占位，不引入外链媒体。", type: "rich-text" },
    ],
    cover: demoMedia(
      origin,
      "rubbing-fragment.svg",
      "topic-rubbing-cover",
      "虚构拓片残片图",
      360,
      480,
    ),
    id: "topic-rubbing-light",
    kind: "editorialTopic",
    title: "拓影光痕",
  },
  {
    blurb: "竖碑、残刻与馆藏语境的短篇导览。",
    blocks: [
      { text: "石碑与它所在的庭院、道路共同被观看。", type: "lead" },
      { text: "游于艺，是在规矩之中找到观看的余韵。", type: "quote" },
    ],
    cover: demoMedia(
      origin,
      "stele-shadow.svg",
      "topic-stele-cover",
      "虚构碑影图",
      360,
      400,
    ),
    id: "topic-stele-shadow",
    kind: "editorialTopic",
    title: "碑影侧记",
  },
  {
    blurb: "山门、道路与题记之间的观看路径。",
    blocks: [
      { text: "路径决定人们接近石刻的方式。", type: "lead" },
      { text: "本条目仍为明确标注的开发期虚构策展内容。", type: "rich-text" },
    ],
    cover: demoMedia(
      origin,
      "cliff-gate.svg",
      "topic-gate-cover",
      "虚构山门路径图",
      360,
      520,
    ),
    id: "topic-gate-path",
    kind: "editorialTopic",
    title: "山门路径",
  },
  {
    blurb: "以残字的留白观察时间留下的尺度。",
    blocks: [
      { text: "缺损并不是任意补写的邀请。", type: "lead" },
      { text: "留白让观看者意识到资料边界。", type: "quote" },
    ],
    cover: demoMedia(
      origin,
      "stone-detail.svg",
      "topic-fragment-cover",
      "虚构石刻残字图",
      360,
      610,
    ),
    id: "topic-fragment-space",
    kind: "editorialTopic",
    title: "残字与留白",
  },
  {
    blurb: "从一处谷壁的光线变化理解文字表面。",
    blocks: [
      { text: "同一处石面会在一天之中显出不同层次。", type: "lead" },
      { text: "演示内容不代表真实地点或著录。", type: "rich-text" },
    ],
    cover: demoMedia(
      origin,
      "valley-wall.svg",
      "topic-valley-cover",
      "虚构谷壁光线图",
      360,
      430,
    ),
    id: "topic-valley-light",
    kind: "editorialTopic",
    title: "谷壁光线",
  },
];

const collectionDefinition = (
  origin: string,
  records: readonly CatalogSummary[],
): CatalogCollectionDefinition => ({
  blurb: "从当前公开 Catalog 摘要组成的开发期专题集合。",
  cover: demoMedia(
    origin,
    "discovery-stone.svg",
    "topic-collection-cover",
    "虚构专题集合封面",
    600,
    760,
  ),
  id: "topic-catalog-selection",
  kind: "catalogCollection",
  recordIds: records.slice(0, 6).map(({ id }) => id),
  title: "石刻选集",
});

const populated = <T>(items: readonly T[]): HomeFeedState<T> =>
  items.length === 0 ? { state: "empty" } : { items, state: "populated" };

export const createDevelopmentHomeData = (
  mediaOrigin: string,
  discover: HomeFeedState<CatalogSummary>,
): HomeSurfaceData => {
  const origin = normalizeOrigin(mediaOrigin);
  const catalogRecords = discover.state === "populated" ? discover.items : [];
  const topics: readonly Topic[] = [
    ...editorialTopics(origin),
    resolveCatalogCollection(
      collectionDefinition(origin, catalogRecords),
      catalogRecords,
    ),
  ];
  return {
    discover,
    timeline: populated(createTimelineFixture(origin)),
    topics: populated(topics),
  };
};

export const createDevelopmentHomeScenario = (
  scenario: HomeScenarioName,
  mediaOrigin: string,
  visualRecords: readonly CatalogSummary[],
): DevelopmentHomeScenario => {
  const origin = normalizeOrigin(mediaOrigin);
  const discover = populated(visualRecords);
  const timeline = populated(createTimelineFixture(origin, visualRecords));
  const editorial = editorialTopics(origin);
  const collection = resolveCatalogCollection(
    collectionDefinition(origin, visualRecords),
    visualRecords,
  );
  const baseline: HomeSurfaceData = {
    discover,
    timeline,
    topics: populated([...editorial, collection]),
  };

  switch (scenario) {
    case "discover-empty":
      return {
        data: { ...baseline, discover: { state: "empty" } },
        initialFeed: "discover",
      };
    case "timeline-demo":
      return { data: baseline, initialFeed: "timeline" };
    case "timeline-unavailable":
      return {
        data: { ...baseline, timeline: { state: "unavailable" } },
        initialFeed: "timeline",
      };
    case "topics-editorial":
      return {
        data: { ...baseline, topics: populated(editorial) },
        initialFeed: "discover",
      };
    case "topics-catalog-collection":
      return {
        data: { ...baseline, topics: populated([collection]) },
        initialFeed: "discover",
      };
    case "topics-empty":
      return {
        data: { ...baseline, topics: { state: "empty" } },
        initialFeed: "discover",
      };
    case "topic-long-blocks":
      return {
        data: { ...baseline, topics: populated(editorial) },
        initialFeed: "discover",
        initialTopicId: "topic-cliff-paths",
      };
    case "discover-visual":
      return { data: baseline, initialFeed: "discover" };
  }
};
