import { DefaultTemplate } from "@payloadcms/next/templates";
import type { AdminViewServerProps } from "payload";

import { isOwner } from "../editorial/access";
import { analyticsWorkspace } from "./config";
import { AnalyticsClient } from "./client";

export const AnalyticsView = (props: AdminViewServerProps) => {
  const { req, visibleEntities } = props.initPageResult;
  return (
    <DefaultTemplate {...props} req={req} visibleEntities={visibleEntities}>
      {isOwner(req) ? (
        <AnalyticsClient workspacePath={analyticsWorkspace().path} />
      ) : (
        <p role="alert">此工作区仅限 Owner。</p>
      )}
    </DefaultTemplate>
  );
};
