import { articleAuthorizationConfigFrom } from "@moya/agent-authorization";
import { describe, expect, it } from "vitest";

/**
 * Issue #355, login door. The hosted client policy exists for the Admin issuer.
 * Article's issuer says nothing about it when it reads its registry, so it stays
 * loopback only and refuses a hosted entry when it starts.
 */
describe("the Article issuer's client registry", () => {
  const environment = (clients: unknown): NodeJS.ProcessEnv =>
    ({
      NODE_ENV: "development",
      ARTICLE_AUTHORING_ENABLED: "true",
      ARTICLE_AUTHORING_ISSUER: "http://127.0.0.1:34700",
      ARTICLE_AUTHORIZATION_PORT: "34700",
      ARTICLE_AUTHORING_RESOURCE:
        "http://127.0.0.1:34701/mcp/article-authoring",
      ARTICLE_AUTHORING_CONSENT_ORIGIN: "http://localhost:34702",
      ARTICLE_AUTHORIZATION_DATABASE_URL:
        "postgresql://article@127.0.0.1:5432/synthetic_test",
      ARTICLE_AUTHORING_CLIENTS: JSON.stringify(clients),
    }) as unknown as NodeJS.ProcessEnv;

  const entry = {
    clientId: "https://tool.invalid/oauth/client.json",
    family: "some-tool",
    label: "Some tool",
  };

  it("still reads a loopback entry", () => {
    const config = articleAuthorizationConfigFrom(
      environment([
        { ...entry, redirectUris: ["http://127.0.0.1:34699/callback"] },
      ]),
    );
    expect(config?.clients.get(entry.clientId)?.callbackPolicy).toBe(
      "loopback-ip",
    );
  });

  it("refuses a hosted entry by name", () => {
    expect(() =>
      articleAuthorizationConfigFrom(
        environment([
          {
            ...entry,
            callbackPolicy: "hosted-https",
            redirectUris: ["https://tool.invalid/api/mcp/auth_callback"],
          },
        ]),
      ),
    ).toThrow(expect.objectContaining({ code: "CLIENTS_HOSTED_NOT_ALLOWED" }));
  });
});
