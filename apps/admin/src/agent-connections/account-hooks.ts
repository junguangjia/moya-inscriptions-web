import type {
  CollectionAfterChangeHook,
  CollectionBeforeChangeHook,
  PayloadRequest,
} from "payload";

import { revokeConnectionsOf } from "./decide";
import { consentRuntime } from "./runtime";

/**
 * The login door (amendment 2026-11-05, section 4): a person's connections stop
 * when their account leaves role owner, or changes its password in the Admin.
 *
 * The door already refuses someone who is not an owner, on every request, but that
 * alone would hand everything back on the day the role is restored, with no new
 * consent. A revoke is what makes the stop outlast the demotion. A password change
 * is what someone does after a suspected theft, so it ends what they had connected.
 *
 * Never a reason to refuse the change: a revoke that fails logs a category, and the
 * connection stays until someone disconnects it, as section 22 of the record says.
 * The Development read-only profile stays as #141 measured it, and has no such rule.
 */

// Payload removes the password before the document hook can see it, so what this
// save will do is noticed before that and acted on only once the save has been made.
const stoppingConnections = new WeakSet<PayloadRequest>();

export const noticeConnectionStop: CollectionBeforeChangeHook = ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (operation !== "update") return data;
  const leavesOwner =
    originalDoc?.role === "owner" && (data.role ?? "owner") !== "owner";
  // An empty one is no change: Payload saves a password only when there is one.
  const changesPassword =
    typeof data.password === "string" && data.password !== "";
  if (leavesOwner || changesPassword) stoppingConnections.add(req);
  return data;
};

/** After the audit hook, so a change that could not be recorded revokes nothing. */
export const stopConnections: CollectionAfterChangeHook = async ({
  doc,
  req,
}) => {
  if (!stoppingConnections.delete(req)) return doc;
  try {
    const runtime = consentRuntime();
    if (runtime?.preset === "operator")
      await revokeConnectionsOf(
        runtime,
        `payload-user-${String((doc as { id: number | string }).id)}`,
      );
  } catch {
    req.payload.logger.error({ category: "AGENT_CONNECTION_REVOKE_FAILED" });
  }
  return doc;
};
