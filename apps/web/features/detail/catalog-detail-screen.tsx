import { Icon } from "@moya/ui";

import { CatalogDetailContentPager } from "./catalog-detail-content-pager";
import { CatalogMediaCarousel } from "./catalog-media-carousel";
import { CalligraphyDetailLayout } from "./calligraphy-detail-layout";
import { DesktopCalligraphyDetailLayout } from "./desktop-calligraphy-detail-layout";
import { VerticalText } from "../authors/vertical-text";
import styles from "./catalog-detail.module.css";
import desktopStyles from "./desktop-calligraphy-detail-layout.module.css";

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
  readonly colophon?: ReactNode;
  readonly calligraphy?: boolean;
  readonly desktop?: boolean;
  readonly positionKey?: string | undefined;
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

/** One semantic content renderer, optionally housed in a desktop disclosure. */
const DetailGroup = ({
  group,
  title,
  collapsible,
  open = false,
  children,
}: {
  readonly group: string;
  readonly title: string;
  readonly collapsible: boolean;
  readonly open?: boolean;
  readonly children: ReactNode;
}) =>
  collapsible ? (
    <details
      className={desktopStyles.group}
      data-desktop-information-group={group}
      open={open || undefined}
    >
      <summary>
        <span>{title}</span>
        <Icon name="next" aria-hidden="true" />
      </summary>
      <div
        className={desktopStyles.groupContent}
        data-desktop-group-content=""
        role="region"
        aria-label={title}
        tabIndex={0}
      >
        {children}
      </div>
    </details>
  ) : (
    <>{children}</>
  );

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
  vertical = false,
  headingOnly = false,
  omitHeading = false,
  collapsible = false,
}: {
  readonly detail: CatalogDetailPresentation;
  readonly vertical?: boolean;
  readonly headingOnly?: boolean;
  readonly omitHeading?: boolean;
  readonly collapsible?: boolean;
}) => {
  const text = (value: string) =>
    vertical ? <VerticalText text={value} /> : value;
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
      {omitHeading ? null : detail.contentType === "work" &&
        detail.title === "" ? (
        <h1 className={styles.visuallyHidden} data-detail-untitled="">
          {UNTITLED_WORK_HEADING}
        </h1>
      ) : (
        <h1
          data-detail-title=""
          data-detail-reading-anchor={vertical ? "title" : undefined}
        >
          {text(detail.title)}
        </h1>
      )}
      {!omitHeading && (detail.contentType !== "work" || headingOnly) ? (
        <p className={styles.kindPeriod}>{text(identity)}</p>
      ) : null}
      {!headingOnly && detail.contentType === "work"
        ? (detail.sections ?? [])
            .filter((section) => section.key === "description")
            .map((section) => (
              <DetailGroup
                key={section.key}
                group="work-body"
                title={section.title}
                collapsible={collapsible}
                open
              >
                <p
                  className={styles.workBody}
                  data-detail-section="description"
                  data-detail-reading-anchor={
                    vertical ? "description" : undefined
                  }
                >
                  {text(section.text)}
                </p>
              </DetailGroup>
            ))
        : null}
      {!omitHeading && detail.contentType === "work" ? (
        <WorkPublication
          editedAt={detail.editedAt}
          firstPublishedAt={detail.firstPublishedAt}
        />
      ) : null}
      {headingOnly || detail.summary === undefined ? null : (
        <DetailGroup
          group="summary"
          title="摘要"
          collapsible={collapsible}
          open={detail.facts.length === 0}
        >
          <p
            className={styles.summary}
            data-detail-reading-anchor={vertical ? "summary" : undefined}
          >
            {text(detail.summary)}
          </p>
        </DetailGroup>
      )}
      {headingOnly || detail.aliases.length === 0 ? null : (
        <DetailGroup group="aliases" title="又名" collapsible={collapsible}>
          <div className={styles.aliases}>
            {collapsible ? null : <span>又名</span>}
            <p data-detail-reading-anchor={vertical ? "aliases" : undefined}>
              {text(detail.aliases.join(" · "))}
            </p>
          </div>
        </DetailGroup>
      )}
      {headingOnly || detail.facts.length === 0 ? null : (
        <DetailGroup
          group="facts"
          title="基本资料"
          collapsible={collapsible}
          open
        >
          <section className={styles.factsSection} data-detail-facts="">
            {collapsible ? null : <h2>基本资料</h2>}
            <dl className={styles.facts}>
              {detail.facts.map((fact, index) => (
                <div key={`${fact.label}-${fact.value}-${index}`}>
                  <dt>{fact.label}</dt>
                  <dd
                    data-detail-reading-anchor={
                      vertical ? `fact-${index}` : undefined
                    }
                  >
                    {text(fact.value)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </DetailGroup>
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
  vertical = false,
  collapsible = false,
}: {
  readonly authorship: DetailAuthorshipPresentation;
  readonly vertical?: boolean;
  readonly collapsible?: boolean;
}) => (
  <DetailGroup group="authorship" title="作品性质" collapsible={collapsible}>
    <section
      className={styles.readingSection}
      data-detail-authorship={authorship.kind}
      data-detail-section="authorship"
    >
      {collapsible ? null : <h2>作品性质</h2>}
      <p data-detail-authorship-label="">{authorship.label}</p>
      {authorship.references.length === 0 ? null : (
        <div className={styles.factsSection}>
          <dl className={styles.facts} data-detail-authorship-references="">
            {authorship.references.map((reference, index) => (
              <div key={reference.label}>
                <dt>{reference.label}</dt>
                <dd
                  data-detail-reading-anchor={
                    vertical ? `authorship-${index}` : undefined
                  }
                >
                  {vertical ? (
                    <VerticalText text={reference.value} />
                  ) : (
                    reference.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  </DetailGroup>
);

const DetailReadingFlow = ({
  detail,
  vertical = false,
  collapsible = false,
}: {
  readonly detail: CatalogDetailPresentation;
  readonly vertical?: boolean;
  readonly collapsible?: boolean;
}) => {
  const sections = (detail.sections ?? []).filter(
    (section) => detail.contentType !== "work" || section.key !== "description",
  );
  const authorship = authorshipOf(detail);
  if (!hasReadingFlow(detail)) return null;

  return (
    <div className={styles.readingFlow}>
      {sections.map((section) => (
        <DetailGroup
          key={section.key}
          group={section.key}
          title={section.title}
          collapsible={collapsible}
          open={
            detail.summary === undefined &&
            detail.facts.length === 0 &&
            section === sections[0]
          }
        >
          <section
            className={styles.readingSection}
            data-detail-section={section.key}
          >
            {collapsible ? null : <h2>{section.title}</h2>}
            <p data-detail-reading-anchor={vertical ? section.key : undefined}>
              {vertical ? <VerticalText text={section.text} /> : section.text}
            </p>
          </section>
        </DetailGroup>
      ))}
      {authorship === null ? null : (
        <DetailAuthorship
          authorship={authorship}
          vertical={vertical}
          collapsible={collapsible}
        />
      )}
      {detail.sourceCitations.length === 0 ? null : (
        <DetailGroup
          group="sources"
          title="资料来源"
          collapsible={collapsible}
          open={sections.length === 0 && authorship === null}
        >
          <section
            className={styles.readingSection}
            data-detail-section="sources"
          >
            {collapsible ? null : <h2>资料来源</h2>}
            <ul className={styles.sources}>
              {detail.sourceCitations.map((citation, index) => (
                <li
                  key={`${citation.label}-${index}`}
                  data-detail-reading-anchor={
                    vertical ? `source-${index}` : undefined
                  }
                >
                  <strong>
                    {vertical ? (
                      <VerticalText text={citation.label} />
                    ) : (
                      citation.label
                    )}
                  </strong>
                  {citation.citation === undefined ? null : (
                    <span>
                      {vertical ? (
                        <VerticalText text={citation.citation} />
                      ) : (
                        citation.citation
                      )}
                    </span>
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
        </DetailGroup>
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
  colophon,
  calligraphy = false,
  desktop = false,
  positionKey,
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
  if (withdrawn !== null) {
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

    body =
      calligraphy && desktop ? (
        <DesktopCalligraphyDetailLayout
          key={detail.id}
          activeMediaIndex={activeMediaIndex}
          colophon={colophon}
          detail={detail}
          detailActions={detailActions}
          positionKey={positionKey}
          leading={<DetailIdentity detail={detail} vertical headingOnly />}
          information={
            <>
              <DetailIdentity
                detail={detail}
                vertical
                omitHeading
                collapsible
              />
              <DetailReadingFlow detail={detail} vertical collapsible />
            </>
          }
          onActiveMediaIndexChange={onActiveMediaIndexChange}
          onOpenViewer={onOpenViewer}
          viewerOpen={mediaMotionSuspended}
        />
      ) : calligraphy ? (
        <CalligraphyDetailLayout
          key={detail.id}
          activeMediaIndex={activeMediaIndex}
          colophon={colophon}
          detail={detail}
          detailActions={detailActions}
          positionKey={positionKey}
          information={
            <>
              <DetailIdentity detail={detail} vertical />
              <DetailReadingFlow detail={detail} vertical />
            </>
          }
          onActiveMediaIndexChange={onActiveMediaIndexChange}
          onOpenViewer={onOpenViewer}
          viewerOpen={mediaMotionSuspended}
        />
      ) : pagedComments ? (
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
      data-detail-mode={calligraphy ? "calligraphy" : "normal"}
      data-detail-source={
        state.state === "loaded" ? state.detail.source : undefined
      }
      data-detail-state={state.state}
      // Shown from a work record already received, until its read confirms it;
      // a withdrawal notice no longer shows that work.
      data-detail-provisional={
        withdrawn === null &&
        state.state === "loaded" &&
        state.detail.contentType === "work" &&
        state.detail.provisional === true
          ? ""
          : undefined
      }
      data-platform={platform}
      data-desktop-detail={desktop ? "" : undefined}
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
        {desktop &&
        state.state === "loaded" &&
        withdrawn === null &&
        state.detail.title !== "" ? (
          <p className={styles.headerTitle}>{state.detail.title}</p>
        ) : (
          <span aria-hidden="true" />
        )}
      </header>
      <div className={styles.detailContent}>{body}</div>
    </section>
  );
};
