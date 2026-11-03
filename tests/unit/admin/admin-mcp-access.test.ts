import type { PayloadRequest } from "payload";
import { describe, expect, it } from "vitest";

import {
  actsAsOwner,
  canEditCatalog,
  catalogScopeAccess,
  EditorialError,
  isAiOperator,
  isHumanOwner,
  isOwner,
} from "admin/editorial";
import { Users } from "admin/users";

// A synthetic value built at runtime, so no credential-shaped literal is tracked.
const signedValue = ["signed", "value"].join("-");
const bearerSigned = ["Bearer", signedValue].join(" ");

const request = (
  user: Record<string, unknown> | null,
  headers: Record<string, string> = {},
) =>
  ({
    headers: new Headers(headers),
    payload: { config: { cookiePrefix: "payload" } },
    t: () => "denied",
    user: user && { collection: "users", id: 7, ...user },
  }) as unknown as PayloadRequest;

const session = { cookie: `theme=dark; payload-token=${signedValue}` };
const owner = (strategy?: string) => ({
  role: "owner",
  ...(strategy ? { _strategy: strategy } : {}),
});
const browserOwner = request(owner("local-jwt"), session);

describe("Admin MCP predicates", () => {
  it("grants ai_operator authority only through the MCP key strategy", () => {
    const row = (strategy?: string) =>
      request({ role: "ai_operator", _strategy: strategy });
    expect(isAiOperator(row("mcp-api-key"))).toBe(true);
    expect(actsAsOwner(row("mcp-api-key"))).toBe(true);
    for (const strategy of [
      "local-jwt",
      "api-key",
      "users-api-key",
      undefined,
    ]) {
      expect(isAiOperator(row(strategy))).toBe(false);
      expect(actsAsOwner(row(strategy))).toBe(false);
      expect(canEditCatalog(row(strategy), "any")).toBe(false);
      expect(catalogScopeAccess(row(strategy))).toBe(false);
    }
    expect(canEditCatalog(row("mcp-api-key"), "any")).toBe(true);
    expect(catalogScopeAccess(row("mcp-api-key"))).toBe(true);
    expect(isOwner(row("mcp-api-key"))).toBe(false);
  });

  it("keeps a role from another collection or an automation key out", () => {
    expect(
      isAiOperator(
        request({
          role: "ai_operator",
          _strategy: "mcp-api-key",
          collection: "payload-mcp-api-keys",
        }),
      ),
    ).toBe(false);
    expect(
      actsAsOwner(request({ role: "automation", _strategy: "mcp-api-key" })),
    ).toBe(false);
    expect(actsAsOwner(request(null))).toBe(false);
  });

  it("recognizes the Owner on every credential, as today", () => {
    for (const strategy of ["local-jwt", "api-key", "mcp-api-key", undefined]) {
      expect(isOwner(request(owner(strategy)))).toBe(true);
      expect(actsAsOwner(request(owner(strategy)))).toBe(true);
    }
  });

  it("passes only an Owner browser session as the human Owner", () => {
    expect(isHumanOwner(browserOwner)).toBe(true);
    for (const [label, refused] of [
      [
        "Authorization JWT beside the cookie",
        request(owner("local-jwt"), {
          ...session,
          authorization: "JWT signed-token",
        }),
      ],
      [
        "Authorization Bearer beside the cookie",
        request(owner("local-jwt"), {
          ...session,
          authorization: bearerSigned,
        }),
      ],
      [
        "Authorization JWT with no cookie",
        request(owner("local-jwt"), { authorization: "JWT signed-token" }),
      ],
      ["no cookie", request(owner("local-jwt"))],
      [
        "empty cookie",
        request(owner("local-jwt"), { cookie: "payload-token=" }),
      ],
      [
        "another cookie name",
        request(owner("local-jwt"), { cookie: `other-token=${signedValue}` }),
      ],
      ["Owner REST key", request(owner("api-key"), session)],
      ["Owner-bound MCP key", request(owner("mcp-api-key"), session)],
      ["no strategy", request(owner(), session)],
      [
        "automation session",
        request({ role: "automation", _strategy: "local-jwt" }, session),
      ],
      [
        "ai_operator session",
        request({ role: "ai_operator", _strategy: "local-jwt" }, session),
      ],
      ["anonymous", request(null, session)],
    ] as const)
      expect([label, isHumanOwner(refused)]).toEqual([label, false]);
  });
});

describe("Admin accounts as a reserved surface", () => {
  const access = Users.access!;
  const callers = {
    browserOwner,
    ownerJwtHeader: request(owner("local-jwt"), {
      authorization: "JWT signed-token",
    }),
    ownerBearerHeader: request(owner("local-jwt"), {
      authorization: bearerSigned,
    }),
    ownerRestKey: request(owner("api-key"), {
      authorization: "users API-Key secret",
    }),
    automationKey: request({ role: "automation", _strategy: "api-key" }),
    aiOperatorKey: request({ role: "ai_operator", _strategy: "mcp-api-key" }),
    aiOperatorJwt: request({ role: "ai_operator", _strategy: "local-jwt" }),
    anonymous: request(null),
  };
  const only = (
    rule: (args: { req: PayloadRequest }) => unknown,
    allowed: keyof typeof callers,
  ) => {
    for (const [name, req] of Object.entries(callers))
      expect([name, rule({ req })]).toEqual([name, name === allowed]);
  };

  it("lets only the browser session create, update and unlock", () => {
    only(access.create as never, "browserOwner");
    only(access.update as never, "browserOwner");
    only(access.unlock as never, "browserOwner");
    expect((access.delete as () => unknown)()).toBe(false);
  });

  it("keeps the role and binding fields on the browser session", () => {
    const fieldsWithAccess = [
      Users.fields[0],
      ...(Users.fields[1] as { fields: unknown[] }).fields,
    ] as {
      name: string;
      access: Record<
        "create" | "update",
        (args: { req: PayloadRequest }) => unknown
      >;
    }[];
    expect(fieldsWithAccess.map(({ name }) => name)).toEqual([
      "role",
      "agentPrincipal",
      "scopeCatalogIds",
    ]);
    for (const field of fieldsWithAccess) {
      only(field.access.create, "browserOwner");
      only(field.access.update, "browserOwner");
    }
  });

  it("narrows other Owner credentials to their own row so /api/users/me still works", () => {
    const read = access.read as (args: { req: PayloadRequest }) => unknown;
    expect(read({ req: callers.browserOwner })).toBe(true);
    for (const req of [
      callers.ownerJwtHeader,
      callers.ownerBearerHeader,
      callers.ownerRestKey,
    ])
      expect(read({ req })).toEqual({ id: { equals: 7 } });
    for (const req of [
      callers.automationKey,
      callers.aiOperatorKey,
      callers.aiOperatorJwt,
      callers.anonymous,
    ])
      expect(read({ req })).toBe(false);
  });

  it("keeps the Admin entry on the Owner role and refuses bulk edit", () => {
    const admin = access.admin as (args: { req: PayloadRequest }) => unknown;
    expect(admin({ req: callers.ownerJwtHeader })).toBe(true);
    expect(admin({ req: callers.aiOperatorKey })).toBe(false);
    expect(Users.disableBulkEdit).toBe(true);
  });

  it("offers exactly three roles and keeps automation the default", () => {
    const role = Users.fields[0] as {
      defaultValue: string;
      options: { value: string }[];
    };
    expect(role.options.map(({ value }) => value)).toEqual([
      "owner",
      "automation",
      "ai_operator",
    ]);
    expect(role.defaultValue).toBe("automation");
  });

  it("refuses a password login on an ai_operator row", () => {
    const hook = Users.hooks!.beforeLogin![0]! as (args: unknown) => unknown;
    expect(() =>
      hook({ req: browserOwner, user: { role: "ai_operator" } }),
    ).toThrow();
    const allowed = { role: "automation" };
    expect(hook({ req: browserOwner, user: allowed })).toBe(allowed);
  });

  it("refuses a REST key on an ai_operator row, however the write arrives", () => {
    const hook = Users.hooks!.beforeChange![0]! as (args: {
      data: Record<string, unknown>;
      originalDoc?: Record<string, unknown>;
    }) => unknown;
    const refused = expect.objectContaining({
      code: "AI_OPERATOR_REST_KEY_REFUSED",
    });
    const attempt = (args: Parameters<typeof hook>[0]) => {
      try {
        return hook(args);
      } catch (error) {
        expect(error).toBeInstanceOf(EditorialError);
        return error;
      }
    };
    expect(
      attempt({ data: { role: "ai_operator", enableAPIKey: true } }),
    ).toEqual(refused);
    expect(
      attempt({
        data: { enableAPIKey: true },
        originalDoc: { role: "ai_operator" },
      }),
    ).toEqual(refused);
    expect(
      attempt({
        data: { role: "ai_operator" },
        originalDoc: { role: "automation", enableAPIKey: true },
      }),
    ).toEqual(refused);
    const allowed = { role: "ai_operator", enableAPIKey: false };
    expect(attempt({ data: allowed })).toBe(allowed);
    const automation = { enableAPIKey: true };
    expect(
      attempt({ data: automation, originalDoc: { role: "automation" } }),
    ).toBe(automation);
  });
});
