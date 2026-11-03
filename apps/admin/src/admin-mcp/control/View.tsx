import { DefaultTemplate } from "@payloadcms/next/templates";
import type { AdminViewServerProps } from "payload";

import { isHumanOwner } from "../../editorial/access";
import { McpControlClient } from "./client";
import { readControlPage } from "./page-data";

/**
 * Payload skips the login redirect for custom views, so this view gates itself,
 * and it reads nothing until it has. Only an Owner browser session passes: a key
 * or an Authorization header on the page request does not.
 */
export const McpControlView = async (props: AdminViewServerProps) => {
  const { req, visibleEntities } = props.initPageResult;
  return (
    <DefaultTemplate {...props} req={req} visibleEntities={visibleEntities}>
      <div className="archive-view">
        {isHumanOwner(req) ? (
          <McpControlClient page={await readControlPage(req)} />
        ) : (
          <p role="alert">此工作区仅限 Owner。</p>
        )}
      </div>
    </DefaultTemplate>
  );
};
