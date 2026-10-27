import { DefaultTemplate } from "@payloadcms/next/templates";
import type { AdminViewServerProps } from "payload";
import { isOwner } from "../editorial/access";
import { AnalyticsClient } from "./client";
import {
  resolveAnalyticsBoardPath,
  resolveAnalyticsWorkspacePath,
} from "./upstream";

const AuditView = ({
  props,
  mode,
  workspacePath = null,
}: {
  props: AdminViewServerProps;
  mode: "open" | "board" | "ips" | "status";
  workspacePath?: string | null;
}) => {
  const { req, visibleEntities } = props.initPageResult;
  return (
    <DefaultTemplate {...props} req={req} visibleEntities={visibleEntities}>
      <div className="archive-view">
        {isOwner(req) ? (
          <AnalyticsClient mode={mode} workspacePath={workspacePath} />
        ) : (
          <p role="alert">此工作区仅限 Owner。</p>
        )}
      </div>
    </DefaultTemplate>
  );
};
export const AnalyticsView = async (props: AdminViewServerProps) => {
  if (!isOwner(props.initPageResult.req))
    return <AuditView props={props} mode="open" />;
  let path: string | null = null;
  try {
    path = await resolveAnalyticsWorkspacePath();
  } catch {
    /* Render a recoverable service state without exposing upstream details. */
  }
  return <AuditView props={props} mode="open" workspacePath={path} />;
};
export const AnalyticsIpView = (props: AdminViewServerProps) => (
  <AuditView props={props} mode="ips" />
);
export const AnalyticsStatusView = (props: AdminViewServerProps) => (
  <AuditView props={props} mode="status" />
);

export const AnalyticsBoardView = async (props: AdminViewServerProps) => {
  if (!isOwner(props.initPageResult.req))
    return <AuditView props={props} mode="board" />;
  let path: string | null = null;
  try {
    path = await resolveAnalyticsBoardPath();
  } catch {
    /* Keep source errors private. */
  }
  return <AuditView props={props} mode="board" workspacePath={path} />;
};
