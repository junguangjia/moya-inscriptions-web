/** The pinned Umami build uses this prefix; it never shares Web/Admin assets. */
export const UMAMI_WORKSPACE_PATH = "/admin/analytics-workspace";

export const analyticsWorkspace = () => {
  const websiteId = process.env.UMAMI_WEBSITE_ID ?? "";
  const boardId = process.env.UMAMI_BOARD_ID ?? "";
  const isId = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value,
    );
  const configured =
    isId(websiteId) &&
    isId(boardId) &&
    Boolean(process.env.UMAMI_ORIGIN) &&
    Boolean(process.env.UMAMI_VIEWER_USERNAME) &&
    Boolean(process.env.UMAMI_VIEWER_PASSWORD);
  return {
    configured,
    path: configured ? `${UMAMI_WORKSPACE_PATH}/boards/${boardId}` : null,
  };
};
