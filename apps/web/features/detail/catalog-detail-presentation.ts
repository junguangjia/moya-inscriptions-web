import {
  localCatalogMediaSrc,
  localCatalogRenditions,
} from "./local-catalog-media";
import type { RenditionCandidate } from "../media/responsive-media";
import type {
  CatalogCitationScope,
  CatalogDetail,
  CatalogKind,
  PublicSourceCitation,
  WorkAuthorship,
  WorkAuthorshipKind,
  WorkMedia,
  WorkVisibility,
} from "@moya/contracts";

export type CatalogDetailSourceIdentity = "qa" | "runtime";

export interface CatalogDetailFact {
  readonly label: string;
  readonly value: string;
}

export type CatalogDetailContentSectionKey =
  "description" | "transcription" | "historicalContext" | "scholarlyResearch";

export interface CatalogDetailContentSection {
  readonly key: CatalogDetailContentSectionKey;
  readonly text: string;
  readonly title: string;
}

export interface CatalogDetailSourceCitationPresentation {
  readonly citation?: string;
  readonly label: string;
  readonly scopeLabel: string;
  readonly url?: string;
}

/** A Live Photo's motion: loaded only when the viewer explicitly plays it. */
export interface DetailLiveMotionPresentation {
  readonly motionSrc: string;
  readonly hasAudio: boolean;
}

/**
 * A work's authorship as readers see it (C05): 原创, 临摹或练习 or 素材分享,
 * and for the latter two only the references the author named.
 */
export interface DetailAuthorshipPresentation {
  readonly kind: WorkAuthorshipKind;
  readonly label: string;
  /** 参考作品 / 原作者 / 来源, in that order, only when named. */
  readonly references: readonly CatalogDetailFact[];
}

export interface DetailMediaPresentation {
  readonly id: string;
  /** The display derivative: cards, the carousel and the Detail page. */
  readonly src: string;
  /** The `full` derivative, shown by the Viewer when the work carries one. */
  readonly fullSrc?: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
  /**
   * Candidates of this image's framing, ascending, with `src` as the anchor:
   * inline surfaces load up to it, the Viewer also the wider zoom levels.
   */
  readonly renditions?: readonly RenditionCandidate[] | undefined;
  /** The opaque asset's colour, for boxes the image covers exactly. */
  readonly placeholderColor?: string | undefined;
  /** Present only for a Live Photo; the still stays the presented image. */
  readonly live?: DetailLiveMotionPresentation;
}
interface DetailPresentationBase {
  readonly aliases: readonly string[];
  readonly facts: readonly CatalogDetailFact[];
  readonly id: string;
  readonly media: readonly DetailMediaPresentation[];
  readonly periodLabel?: string;
  readonly sections?: readonly CatalogDetailContentSection[];
  readonly source: CatalogDetailSourceIdentity;
  readonly sourceCitations: readonly CatalogDetailSourceCitationPresentation[];
  readonly summary?: string;
  readonly title: string;
}

export type CatalogDetailPresentation = DetailPresentationBase &
  (
    | { readonly contentType?: "catalog"; readonly kind: CatalogKind }
    | {
        readonly contentType: "work";
        readonly authorId: string;
        readonly authorName: string;
        readonly authorStudioName?: string | undefined;
        readonly canEdit: boolean;
        readonly available: boolean;
        /** Null until the first public exposure; never labelled as pending. */
        readonly firstPublishedAt?: string | null;
        /** Set after a real content update; shown as 已编辑 beside the first publication time. */
        readonly editedAt?: string | null;
        /** Author-only: the requested visibility of the author's own work. */
        readonly visibility?: WorkVisibility;
        /** Shown to every reader when the work carries it. */
        readonly authorship?: DetailAuthorshipPresentation;
      }
  );

const authorshipLabels = {
  original: "原创",
  copy_practice: "临摹或练习",
  material_sharing: "素材分享",
} as const satisfies Readonly<Record<WorkAuthorshipKind, string>>;

/** The authorship section of a work Detail; whitespace-only references are omitted. */
export const toWorkAuthorshipPresentation = (
  authorship: WorkAuthorship,
): DetailAuthorshipPresentation => ({
  kind: authorship.kind,
  label: authorshipLabels[authorship.kind],
  references:
    authorship.kind === "original"
      ? []
      : (
          [
            ["参考作品", authorship.referenceTitle],
            ["原作者", authorship.originalAuthor],
            ["来源", authorship.sourceNote],
          ] as const
        ).flatMap(([label, value]) => {
          const text = value?.trim() ?? "";
          return text === "" ? [] : [{ label, value: text }];
        }),
});

/**
 * One work media item for Detail and Viewer: a Live Photo keeps its still as
 * the image and carries its motion separately (never preloaded).
 */
export const toWorkMediaPresentation = (
  // `fullSrc` is read structurally until the work media contract names it.
  media: WorkMedia & { readonly fullSrc?: string },
  alt: string,
): DetailMediaPresentation => ({
  id: media.id,
  src: media.src,
  ...(media.fullSrc === undefined ? {} : { fullSrc: media.fullSrc }),
  alt,
  width: media.width,
  height: media.height,
  ...(media.renditions === undefined ? {} : { renditions: media.renditions }),
  ...(media.placeholderColor === undefined
    ? {}
    : { placeholderColor: media.placeholderColor }),
  ...(media.kind === "live" && media.motionSrc !== undefined
    ? {
        live: {
          motionSrc: media.motionSrc,
          hasAudio: media.hasAudio === true,
        },
      }
    : {}),
});

export type CatalogDetailPresentationState =
  | { readonly state: "loading" }
  | { readonly detail: CatalogDetailPresentation; readonly state: "loaded" }
  | { readonly state: "not-found" }
  | { readonly state: "unavailable" }
  | { readonly state: "unexpected-error" };

const regionLabel = (detail: CatalogDetail): string | undefined => {
  const region = [detail.province, detail.prefecture, detail.county]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  return region.length === 0 ? undefined : region;
};

const contributorRoleLabels = {
  calligrapher: "书者",
  textAuthor: "撰文者",
} as const;

const citationScopeLabels = {
  description: "简介",
  historicalContext: "历史背景",
  record: "整体资料",
  scholarlyResearch: "学术研究",
  transcription: "释文",
} satisfies Readonly<Record<CatalogCitationScope, string>>;

const contentSections = [
  ["description", "简介"],
  ["transcription", "释文"],
  ["historicalContext", "历史背景"],
  ["scholarlyResearch", "学术研究"],
] as const;

const toSourceCitationPresentation = (
  citation: PublicSourceCitation,
): CatalogDetailSourceCitationPresentation => {
  const scopes: readonly CatalogCitationScope[] = citation.appliesTo ?? [
    "record",
  ];
  return {
    ...(citation.citation === undefined ? {} : { citation: citation.citation }),
    label: citation.label,
    scopeLabel: scopes.map((scope) => citationScopeLabels[scope]).join("、"),
    ...(citation.url === undefined ? {} : { url: citation.url }),
  };
};

export const toCatalogDetailPresentation = (
  detail: CatalogDetail,
  source: CatalogDetailSourceIdentity,
): CatalogDetailPresentation => {
  const facts: CatalogDetailFact[] = [];
  if (detail.periodLabel === undefined) {
    for (const [label, value] of [
      ["朝代", detail.dynasty],
      ["年代", detail.dateText],
    ] as const) {
      if (value !== undefined) facts.push({ label, value });
    }
  }
  for (const contributor of detail.contributors ?? []) {
    facts.push({
      label: contributorRoleLabels[contributor.role],
      value: contributor.name,
    });
  }
  for (const [label, value] of [
    ["书体", detail.scriptStyle],
    ["地区", regionLabel(detail)],
    ["现址", detail.currentLocation],
    ["现藏单位", detail.currentCustodian],
  ] as const) {
    if (value !== undefined) facts.push({ label, value });
  }
  const media =
    detail.media.length > 0
      ? detail.media
      : detail.representativeMedia === undefined
        ? []
        : [detail.representativeMedia];
  const sections = contentSections.flatMap(([key, title]) => {
    const text = detail[key];
    return text === undefined ? [] : [{ key, text, title }];
  });

  return {
    aliases: detail.aliases,
    facts,
    id: detail.id,
    kind: detail.kind,
    media: media.map((item) => ({
      ...item,
      src: localCatalogMediaSrc(item.src, detail.id, item.id),
      ...(item.renditions === undefined
        ? {}
        : { renditions: localCatalogRenditions(item.renditions) }),
    })),
    ...(detail.periodLabel === undefined
      ? {}
      : { periodLabel: detail.periodLabel }),
    sections,
    source,
    sourceCitations: detail.sourceCitations.map(toSourceCitationPresentation),
    ...(detail.summary === undefined ? {} : { summary: detail.summary }),
    title: detail.title,
  };
};
