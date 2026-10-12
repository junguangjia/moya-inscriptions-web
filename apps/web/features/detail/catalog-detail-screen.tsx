import { Icon } from "@moya/ui";

import { CatalogDetailContentPager } from "./catalog-detail-content-pager";
import { CatalogMediaCarousel } from "./catalog-media-carousel";
import styles from "./catalog-detail.module.css";

import type { ReactNode, RefObject } from "react";
import type {
  CatalogDetailPresentation,
  DetailAuthorshipPresentation,
} from "./catalog-detail-presentation";
import type { CatalogDetailPresentationState } from "./catalog-detail-presentation";
import type { CatalogDetailWithdrawalNotice } from "./catalog-detail-withdrawal";
import type { PresentationPlatform } from "../shell/device-platform";

export interface CatalogDetailScreenProps {
  readonly activeMediaIndex: number;
  readonly backButtonRef: RefObject<HTMLButtonElement | null>;
  readonly commentSection?: ReactNode;
  readonly detailActions?: ReactNode;
  /** True while the Viewer covers the Detail: Live motion in the carousel stops. */
  readonly mediaMotionSuspended?: boolean;
  readonly onActiveMediaIndexChange: (index: number) => void;
  readonly onBack: () => void;
  readonly onOpenViewer: (index: number, opener: HTMLElement) => void;
  readonly orientation: "landscape" | "portrait";
  readonly platform: PresentationPlatform;
  readonly state: CatalogDetailPresentationState;
  /** Set once the loaded content is no longer offered here (e.g. moved to the recycle bin). */
  readonly withdrawn?: CatalogDetailWithdrawalNotice | null;
}

/** An accessible-only name for an untitled work; the stored title stays empty. */
const UNTITLED_WORK_HEADING = "未命名作品";

const DetailMessage = ({
  description,
  role = "status",
  title,
}: {
  readonly description: string;
  readonly role?: "alert" | "status";
  readonly title: string;
}) => (
  <section className={styles.message} role={role}>
    <h1>{title}</h1>
    <p>{description}</p>
  </section>
);

const publicationDate = new Intl.DateTimeFormat("zh-CN", { dateStyle: "long" });

/**
 * A work's first publication time with 已编辑 after a real content update. A
 * work never publicly exposed shows no time and no pending wording.
 */
const WorkPublication = ({
  editedAt,
  firstPublishedAt,
}: {
  readonly editedAt: string | null | undefined;
  readonly firstPublishedAt: string | null | undefined;
}) => {
  if (firstPublishedAt === null || firstPublishedAt === undefined) return null;
  const published = new Date(firstPublishedAt);
  if (Number.isNaN(published.getTime())) return null;
  return (
    <p className={styles.publication} data-detail-publication="">
      <time dateTime={firstPublishedAt}>
        {publicationDate.format(published)}
      </time>
      {editedAt === null || editedAt === undefined ? null : (
        <span data-detail-edited="">已编辑</span>
      )}
    </p>
  );
};

const DetailIdentity = ({
  detail,
}: {
  readonly detail: CatalogDetailPresentation;
}) => {
  const identity = [
    detail.contentType === "work"
      ? detail.authorName
      : detail.kind === "calligraphy"
        ? "书帖"
        : "碑刻",
    detail.periodLabel,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");

  return (
    <section className={styles.identityPanel} data-detail-info-panel="">
      {/* An untitled work keeps its title empty; only assistive technology gets a name. */}
      {detail.contentType === "work" && detail.title === "" ? (
        <h1 className={styles.visuallyHidden} data-detail-untitled="">
          {UNTITLED_WORK_HEADING}
        </h1>
      ) : (
        <h1 data-detail-title="">{detail.title}</h1>
      )}
      {detail.contentType !== "work" ? (
        <p className={styles.kindPeriod}>{identity}</p>
      ) : null}
      {detail.contentType === "work"
        ? (detail.sections ?? [])
            .filter((section) => section.key === "description")
            .map((section) => (
              <p
                key={section.key}
                className={styles.workBody}
                data-detail-section="description"
              >
                {section.text}
              </p>
            ))
        : null}
      {detail.contentType === "work" ? (
        <WorkPublication
          editedAt={detail.editedAt}
          firstPublishedAt={detail.firstPublishedAt}
        />
      ) : null}
      {detail.summary === undefined ? null : (
        <p className={styles.summary}>{detail.summary}</p>
      )}
      {detail.aliases.length === 0 ? null : (
        <div className={styles.aliases}>
          <span>又名</span>
          <p>{detail.aliases.join(" · ")}</p>
        </div>
      )}
      {detail.facts.length === 0 ? null : (
        <section className={styles.factsSection} data-detail-facts="">
          <h2>基本资料</h2>
          <dl className={styles.facts}>
            {detail.facts.map((fact, index) => (
              <div key={`${fact.label}-${fact.value}-${index}`}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </section>
  );
};

/** A work's authorship (C05), one section for every reader when present. */
const authorshipOf = (detail: CatalogDetailPresentation) =>
  detail.contentType === "work" ? (detail.authorship ?? null) : null;

const hasReadingFlow = (detail: CatalogDetailPresentation) =>
  (detail.sections ?? []).some(
    (section) => detail.contentType !== "work" || section.key !== "description",
  ) ||
  authorshipOf(detail) !== null ||
  detail.sourceCitations.length > 0;

const DetailAuthorship = ({
  authorship,
}: {
  readonly authorship: DetailAuthorshipPresentation;
}) => (
  <section
    className={styles.readingSection}
    data-detail-authorship={authorship.kind}
    data-detail-section="authorship"
  >
    <h2>作品性质</h2>
    <p data-detail-authorship-label="">{authorship.label}</p>
    {authorship.references.length === 0 ? null : (
      <div className={styles.factsSection}>
        <dl className={styles.facts} data-detail-authorship-references="">
          {authorship.references.map((reference) => (
            <div key={reference.label}>
              <dt>{reference.label}</dt>
              <dd>{reference.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    )}
  </section>
);

const DetailReadingFlow = ({
  detail,
}: {
  readonly detail: CatalogDetailPresentation;
}) => {
  const sections = (detail.sections ?? []).filter(
    (section) => detail.contentType !== "work" || section.key !== "description",
  );
  const authorship = authorshipOf(detail);
  if (!hasReadingFlow(detail)) return null;

  return (
    <div className={styles.readingFlow}>
      {sections.map((section) => (
        <section
          key={section.key}
          className={styles.readingSection}
          data-detail-section={section.key}
        >
          <h2>{section.title}</h2>
          <p>{section.text}</p>
        </section>
      ))}
      {authorship === null ? null : (
        <DetailAuthorship authorship={authorship} />
      )}
      {detail.sourceCitations.length === 0 ? null : (
        <section
          className={styles.readingSection}
          data-detail-section="sources"
        >
          <h2>资料来源</h2>
          <ul className={styles.sources}>
            {detail.sourceCitations.map((citation, index) => (
              <li key={`${citation.label}-${index}`}>
                <strong>{citation.label}</strong>
                {citation.citation === undefined ? null : (
                  <span>{citation.citation}</span>
                )}
                {citation.url === undefined ? null : (
                  <a href={citation.url} rel="noreferrer" target="_blank">
                    查看来源
                  </a>
                )}
                <span className={styles.citationScope}>
                  适用于：{citation.scopeLabel}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

/** Wide compositions collapse the reading flow so the media keeps its size;
 *  opening 详情 reveals exactly the same sections, unchanged. */
const DetailReadingDisclosure = ({
  detail,
}: {
  readonly detail: CatalogDetailPresentation;
}) => {
  if (!hasReadingFlow(detail)) return null;

  return (
    <details
      className={styles.readingDisclosure}
      data-detail-reading-disclosure=""
    >
      <summary>详情</summary>
      <DetailReadingFlow detail={detail} />
    </details>
  );
};

export const CatalogDetailScreen = ({
  activeMediaIndex,
  backButtonRef,
  commentSection,
  detailActions,
  mediaMotionSuspended = false,
  onActiveMediaIndexChange,
  onBack,
  onOpenViewer,
  orientation,
  platform,
  state,
  withdrawn = null,
}: CatalogDetailScreenProps) => {
  let body;
  if (state.state === "loaded" && withdrawn !== null) {
    // Media, actions and discussion are gone; only the neutral result stays.
    body = (
      <section
        className={styles.message}
        data-detail-withdrawn=""
        role="status"
        tabIndex={-1}
      >
        <h1>{withdrawn.title}</h1>
        <p>{withdrawn.description}</p>
      </section>
    );
  } else if (state.state === "loading") {
    body = (
      <div aria-label="正在加载资料" className={styles.skeleton} role="status">
        <span className={styles.skeletonMedia} />
        <span className={styles.skeletonTitle} />
        <span />
        <span />
      </div>
    );
  } else if (state.state === "not-found") {
    body = (
      <DetailMessage
        description="这项资料可能不存在，或已无法访问。"
        title="未找到这项资料"
      />
    );
  } else if (state.state === "unavailable") {
    body = (
      <DetailMessage
        description="资料服务当前不可用，请返回后稍后再试。"
        title="暂时无法加载资料"
      />
    );
  } else if (state.state === "unexpected-error") {
    body = (
      <DetailMessage
        description="发生了未预期的错误，请返回上一页。"
        role="alert"
        title="暂时无法显示此页面"
      />
    );
  } else {
    const detail = state.detail;
    // A text-only work is complete without media: no missing-image block.
    const textOnly = detail.contentType === "work" && detail.media.length === 0;
    const media = textOnly ? null : (
      <CatalogMediaCarousel
        activeIndex={activeMediaIndex}
        media={detail.media}
        motionSuspended={mediaMotionSuspended}
        onActiveIndexChange={onActiveMediaIndexChange}
        onOpenViewer={onOpenViewer}
        platform={platform}
      />
    );
    const information = (
      <>
        <DetailIdentity detail={detail} />
        <DetailReadingFlow detail={detail} />
      </>
    );
    const pagedComments =
      commentSection !== undefined &&
      (platform === "phone" ||
        (platform === "tablet" && orientation === "portrait"));
    // Wide compositions keep the media and the identity card side by side,
    // collapse the reading flow behind 详情, and read comments underneath.
    const wideComments =
      commentSection !== undefined &&
      (platform === "pc" ||
        (platform === "tablet" && orientation === "landscape"));

    body = pagedComments ? (
      <div className={styles.pagedDetail} data-detail-paged-layout="">
        {media === null ? null : (
          <div className={styles.pagedMedia} data-detail-paged-media="">
            {media}
          </div>
        )}
        {detailActions}
        <CatalogDetailContentPager
          comments={commentSection}
          detailId={detail.id}
          information={information}
          key={detail.id}
          platform={platform}
        />
      </div>
    ) : wideComments ? (
      <div className={styles.landscapeDetail} data-detail-landscape-layout="">
        <div
          className={styles.landscapeStage}
          data-detail-text-only={textOnly ? "" : undefined}
        >
          {media === null ? null : (
            <div data-detail-landscape-media="">{media}</div>
          )}
          <div className={styles.landscapeInfo}>
            <DetailIdentity detail={detail} />
            {detailActions}
            {/* Without media the text is the work: it reads in full. */}
            {textOnly ? (
              <DetailReadingFlow detail={detail} />
            ) : (
              <DetailReadingDisclosure detail={detail} />
            )}
          </div>
        </div>
        <section
          aria-label="评论"
          className={styles.landscapeComments}
          data-detail-landscape-comments=""
        >
          {commentSection}
        </section>
      </div>
    ) : (
      <>
        <div
          className={styles.hero}
          data-detail-text-only={textOnly ? "" : undefined}
        >
          {media}
          <DetailIdentity detail={detail} />
          {detailActions}
        </div>
        <DetailReadingFlow detail={detail} />
        {commentSection}
      </>
    );
  }

  return (
    <section
      aria-label="资料详情"
      aria-modal="true"
      className={styles.detail}
      data-detail-composition={`${platform}-${orientation}`}
      data-detail-source={
        state.state === "loaded" ? state.detail.source : undefined
      }
      data-detail-state={state.state}
      data-platform={platform}
      role="dialog"
    >
      <header className={styles.detailHeader}>
        <button
          ref={backButtonRef}
          aria-label="返回"
          onClick={onBack}
          type="button"
        >
          <Icon aria-hidden="true" name="back" />
        </button>
        <span aria-hidden="true" />
      </header>
      <div className={styles.detailContent}>{body}</div>
    </section>
  );
};
