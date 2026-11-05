import { ADMIN_MCP_OPERATOR_ROW_EMAIL } from "@moya/contracts/internal/admin-mcp";
import { createLocalReq, type Payload } from "payload";
import { lockEditorialKey, withEditorialTransaction } from "./transaction";

/** Offline initial setup only. Never routed through REST, GraphQL or MCP. */
export const provisionInitialOwner = async (
  payload: Payload,
  input: { readonly email: string; readonly password: string },
): Promise<{ readonly id: string | number }> => {
  if (
    !input.email ||
    input.email.trim() !== input.email ||
    input.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+$/u.test(input.email) ||
    input.password.length < 20 ||
    input.password.length > 128 ||
    input.password.includes(String.fromCharCode(0)) ||
    /[\uD800-\uDFFF]/u.test(input.password)
  )
    throw new Error("INITIAL_OWNER_SETUP_REFUSED");
  const req = await createLocalReq({}, payload);
  return withEditorialTransaction(req, async () => {
    await lockEditorialKey(req, "initial-owner-setup");
    const existing = await payload.count({
      collection: "users",
      overrideAccess: true,
      req,
      // The migrations seed the login door's row, which nobody can sign in with, so
      // it is not an account yet. Only that exact row: its address on another role,
      // or another ai_operator account, still refuses.
      where: {
        or: [
          { email: { not_equals: ADMIN_MCP_OPERATOR_ROW_EMAIL } },
          { role: { not_equals: "ai_operator" } },
        ],
      },
    });
    if (existing.totalDocs !== 0)
      throw new Error("INITIAL_OWNER_ALREADY_EXISTS");
    const owner = await payload.create({
      collection: "users",
      overrideAccess: true,
      req,
      data: {
        email: input.email,
        password: input.password,
        role: "owner",
        scopeCatalogIds: [],
      },
    });
    return { id: owner.id };
  });
};
