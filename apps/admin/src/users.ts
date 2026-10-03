import type { Access, CollectionConfig, FieldAccess } from "payload";
const owner: Access = ({ req }) =>
  req.user?.collection === "users" && req.user.role === "owner";
const ownerField: FieldAccess = ({ req }) =>
  req.user?.collection === "users" && req.user.role === "owner";
export const initialUserEndpoints = (
  environment = process.env.CMS_ENVIRONMENT,
): NonNullable<CollectionConfig["endpoints"]> =>
  environment === "synthetic"
    ? []
    : [
        {
          path: "/first-register",
          method: "post",
          handler: () =>
            Response.json(
              { error: "OPERATOR_SETUP_REQUIRED" },
              { status: 403 },
            ),
        },
      ];
export const Users: CollectionConfig = {
  slug: "users",
  labels: { singular: "操作身份", plural: "操作身份" },
  admin: { useAsTitle: "email", group: "系统与自动化" },
  auth: {
    useAPIKey: true,
    tokenExpiration: 7200,
    maxLoginAttempts: 5,
    lockTime: 600000,
    cookies: {
      secure: process.env.CMS_ENVIRONMENT !== "synthetic",
      sameSite: "Strict",
    },
  },
  access: {
    admin: ({ req }) => owner({ req }) === true,
    create: owner,
    read: owner,
    update: owner,
    delete: () => false,
    unlock: owner,
  },
  endpoints: initialUserEndpoints(),
  fields: [
    {
      name: "role",
      type: "select",
      label: "角色",
      required: true,
      defaultValue: "automation",
      options: [
        { label: "Owner", value: "owner" },
        { label: "内容自动化", value: "automation" },
      ],
      access: { create: ownerField, update: ownerField },
    },
    {
      // Agent Administration V1 (Issue #141 r3): the machine principal this
      // operator identity's MCP API key acts as. The Backend holds the
      // principal's scopes and revocation; this is only the binding, and it
      // is never a public identity. Owner-only.
      name: "agentPrincipal",
      type: "text",
      label: "代理主体标签",
      required: false,
      access: { create: ownerField, update: ownerField },
      validate: (value: unknown) =>
        value === undefined ||
        value === null ||
        value === "" ||
        (typeof value === "string" && /^agent-[a-z0-9-]{2,57}$/u.test(value)) ||
        "代理主体标签形如 agent-xxx（小写字母、数字、连字符）",
    },
    {
      name: "scopeCatalogIds",
      type: "json",
      label: "获准内容范围",
      defaultValue: [],
      access: { create: ownerField, update: ownerField },
      validate: (value: unknown) =>
        (Array.isArray(value) &&
          value.length <= 10000 &&
          value.every(
            (id: unknown) =>
              typeof id === "string" &&
              /^[^\s]{1,128}$/.test(id) &&
              !id.includes(String.fromCharCode(0)),
          )) ||
        "需要明确的 CatalogId 范围",
    },
  ],
};
