import type { VisitorAccess } from "./product-access";
import type { WideScreenBrowseOnlyHint } from "../features/shell/browse-only";

/** Retired by the Owner's #260 release decision. Old deployment settings must
 * never hide existing product or authentication entries by device size again.
 * The exports stay compatible with retained callers; account access is still
 * enforced by ProductAccess and the Backend, independently of presentation. */
export const WIDE_SCREEN_BROWSE_ONLY_ENV = "MOYA_WIDE_SCREEN_BROWSE_ONLY";
export const isWideScreenBrowseOnlyEnabled = (
  _legacyValue?: string,
): boolean => {
  void _legacyValue;
  return false;
};
export const wideScreenBrowseOnlyHint = (
  _access: Extract<VisitorAccess, { state: "granted" }>,
): WideScreenBrowseOnlyHint | undefined => {
  void _access;
  return undefined;
};
export const AUTH_PAGE_ACCESS_WAIT_MS = 1_500;
export const readAuthPageWideScreenRedirect = (
  _legacyWaitMs: number = AUTH_PAGE_ACCESS_WAIT_MS,
): Promise<boolean> => {
  void _legacyWaitMs;
  return Promise.resolve(false);
};
