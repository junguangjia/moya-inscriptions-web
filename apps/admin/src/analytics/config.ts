/** The pinned Umami build uses this prefix; it never shares Web/Admin assets. */
export const UMAMI_WORKSPACE_PATH = "/admin/analytics-workspace";

export const analyticsWorkspace = () => {
  const websiteId = process.env.UMAMI_WEBSITE_ID ?? "";
  const configured =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      websiteId,
    ) &&
    Boolean(process.env.UMAMI_ORIGIN) &&
    Boolean(process.env.UMAMI_VIEWER_USERNAME) &&
    Boolean(process.env.UMAMI_VIEWER_PASSWORD);
  return {
    configured,
    path: configured ? `${UMAMI_WORKSPACE_PATH}/websites/${websiteId}` : null,
  };
};
