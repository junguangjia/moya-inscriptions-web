import { RegisteredClientError } from "@moya/community-postgres";
import {
  CONSENT_LANDING_PREFIX,
  ConsentError,
  admitReadOnlyCapabilities,
  consentDecisionSchema,
  consentReviewPath,
  consentTicketsEqual,
  describeConsent,
  digestConsentTicket,
  interactionUidSchema,
  mintConsentTicket,
  parseRegisteredClients,
  providerResumeUrl,
} from "admin/agent-connections-consent";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

/**
 * Agent Connections V1 (Issue #141 r15 §5) — the consent rules, without a
 * framework.
 *
 * Imported through its own subpath rather than the package barrel, for the
 * reason r14 measured: the barrel reaches `payload` and now `pg`, and a fast
 * lane that pays for a database driver to check a URL rule stops being fast.
 */
describe("consent rules", () => {
  const live = {
    interactionUid: "abc123_-XYZ",
    oauthClientId: "artvenn-claude-01",
    resource: "https://resource.invalid/api/mcp",
    capabilityScopes: ["artvenn:read"],
    protocolScopes: ["offline_access"],
    preset: "read-only" as const,
    expiresAt: new Date("2026-09-20T12:05:00Z").toISOString(),
    environment: "development",
    now: new Date("2026-09-20T12:00:00Z"),
  };

  describe("the milestone is read-only, and says so rather than narrowing", () => {
    it("refuses management instead of quietly dropping it", () => {
      // The direction matters. Narrowing would hand back a working token
      // having ignored what was asked for: the caller would believe it had
      // management and find out by being denied later, and the Owner would
      // have approved a screen that never mentioned it.
      expect(() =>
        admitReadOnlyCapabilities(["artvenn:read", "artvenn:manage"]),
      ).toThrow(ConsentError);
      expect(() => admitReadOnlyCapabilities(["artvenn:manage"])).toThrow(
        ConsentError,
      );
    });

    it("refuses an unknown capability and an empty request", () => {
      expect(() => admitReadOnlyCapabilities(["artvenn:everything"])).toThrow(
        ConsentError,
      );
      expect(() => admitReadOnlyCapabilities([])).toThrow(ConsentError);
      // `offline_access` grants no business authority, so a request carrying
      // only it has asked for nothing.
      expect(() => admitReadOnlyCapabilities(["offline_access"])).toThrow(
        ConsentError,
      );
    });

    it("keeps one canonical spelling of what was consented to", () => {
      expect(
        admitReadOnlyCapabilities([
          "offline_access",
          "artvenn:read",
          "artvenn:read",
        ]),
      ).toEqual(["artvenn:read"]);
    });

    it("refuses a management preset even when the scopes look read-only", () => {
      expect(() =>
        describeConsent({ ...live, preset: "management" as never }),
      ).toThrow(ConsentError);
    });
  });

  describe("the display is what the decision is bound to", () => {
    it("renders exactly the provider's facts", () => {
      expect(describeConsent(live)).toEqual({
        interaction: "abc123_-XYZ",
        client: "artvenn-claude-01",
        resource: "https://resource.invalid/api/mcp",
        environment: "development",
        capabilities: ["artvenn:read"],
        protocol: ["offline_access"],
        preset: "read-only",
        expiresAt: "2026-09-20T12:05:00.000Z",
      });
    });

    it("refuses an interaction that is already dead, rather than showing it as live", () => {
      expect(() =>
        describeConsent({
          ...live,
          now: new Date("2026-09-20T12:05:00Z"),
        }),
      ).toThrow(ConsentError);
      expect(() =>
        describeConsent({ ...live, expiresAt: "not a time" }),
      ).toThrow(ConsentError);
    });

    it("refuses a resource that could be two audiences", () => {
      for (const resource of [
        "https://resource.invalid/api/mcp?tenant=2",
        "https://resource.invalid/api/mcp#fragment",
        "ftp://resource.invalid/api/mcp",
        "not a url",
      ])
        expect(() => describeConsent({ ...live, resource })).toThrow(
          ConsentError,
        );
    });

    it("refuses a malformed interaction or client before rendering either", () => {
      for (const interactionUid of ["", "a b", "../escape", "a/b", "a?b"])
        expect(() => describeConsent({ ...live, interactionUid })).toThrow(
          ConsentError,
        );
      expect(() =>
        describeConsent({
          ...live,
          oauthClientId: "has://scheme-but-not-https",
        }),
      ).toThrow(ConsentError);
    });

    it("drops a protocol scope it does not recognise rather than displaying it", () => {
      // Unlike a capability, a protocol scope grants nothing, so an unknown
      // one is not a refusal — but it must not appear on the screen as though
      // the human agreed to it.
      expect(
        describeConsent({
          ...live,
          protocolScopes: ["offline_access", "something_else"],
        }).protocol,
      ).toEqual(["offline_access"]);
    });
  });

  describe("no request field reaches a URL", () => {
    it("builds the continuation as a path on this origin", () => {
      expect(consentReviewPath("abc123")).toBe(
        "/admin/agent-connections/consent?interaction=abc123",
      );
      // The uid is the only input, and it is validated before it is used, so
      // there is nothing here for an arbitrary return URL to arrive through.
      for (const uid of ["https://elsewhere.invalid", "a b", "../../x", ""])
        expect(() => consentReviewPath(uid)).toThrow(ConsentError);
    });

    it("builds the resume from the CONFIGURED issuer, never from a caller", () => {
      // Under the consent prefix, not a tidier /interaction/<uid>/resume:
      // oidc-provider scopes its interaction cookie to the pathname of the
      // consent destination, so a route outside that prefix is one the
      // browser reaches without the cookie that names the interaction.
      expect(providerResumeUrl("https://auth.localhost:34620", "abc123")).toBe(
        "https://auth.localhost:34620/agent-connections/consent/abc123/resume",
      );
      expect(providerResumeUrl("https://auth.localhost:34620/", "abc123")).toBe(
        "https://auth.localhost:34620/agent-connections/consent/abc123/resume",
      );
      expect(
        providerResumeUrl("https://auth.localhost:34620", "abc123"),
      ).toContain(`${CONSENT_LANDING_PREFIX}/abc123/resume`);
      expect(consentReviewPath("abc123")).toContain(CONSENT_LANDING_PREFIX);
      for (const issuer of [
        "https://auth.localhost:34620?x=1",
        "https://auth.localhost:34620#x",
        "ftp://auth.localhost",
        "",
      ])
        expect(() => providerResumeUrl(issuer, "abc123")).toThrow(ConsentError);
      expect(() =>
        providerResumeUrl("https://auth.localhost:34620", "../../elsewhere"),
      ).toThrow(ConsentError);
    });
  });

  describe("the ticket", () => {
    it("is 32 bytes, and only its digest is meant to be stored", () => {
      const first = mintConsentTicket();
      const second = mintConsentTicket();
      expect(first.ticket).toMatch(/^[0-9a-f]{64}$/u);
      expect(first.ticket).not.toBe(second.ticket);
      expect(first.digest).toBe(
        createHash("sha256").update(first.ticket, "utf8").digest("hex"),
      );
      // The stored value must not be the presented one.
      expect(first.digest).not.toBe(first.ticket);
    });

    it("compares without leaking a length or a prefix through a throw", () => {
      const { ticket } = mintConsentTicket();
      expect(consentTicketsEqual(ticket, ticket)).toBe(true);
      expect(consentTicketsEqual(ticket, ticket.slice(0, 10))).toBe(false);
      expect(consentTicketsEqual(ticket, `${ticket}0`)).toBe(false);
    });
  });

  describe("the POST body", () => {
    const body = {
      interaction: "abc123",
      ticket: "a".repeat(64),
      decision: "approve",
    };

    it("requires an explicit decision, so arriving is not approving", () => {
      expect(consentDecisionSchema.safeParse(body).success).toBe(true);
      expect(
        consentDecisionSchema.safeParse({ ...body, decision: undefined })
          .success,
      ).toBe(false);
      expect(
        consentDecisionSchema.safeParse({ ...body, decision: true }).success,
      ).toBe(false);
      expect(
        consentDecisionSchema.safeParse({ ...body, decision: "yes" }).success,
      ).toBe(false);
    });

    it("refuses an extra field rather than ignoring it", () => {
      expect(
        consentDecisionSchema.safeParse({ ...body, preset: "management" })
          .success,
      ).toBe(false);
      expect(
        consentDecisionSchema.safeParse({ ...body, ticket: "A".repeat(64) })
          .success,
      ).toBe(false);
      expect(
        consentDecisionSchema.safeParse({ ...body, interaction: "a b" })
          .success,
      ).toBe(false);
    });
  });

  describe("the registry is shared configuration, not a second copy", () => {
    const entry = {
      clientId: "artvenn-claude-01",
      family: "claude",
      label: "Claude",
      redirectUris: ["http://127.0.0.1:34699/callback"],
    };
    const one = JSON.stringify([entry]);

    it("reads exactly what it is given, and defaults to the strict callback policy", () => {
      // The policy is OPTIONAL in the setting and STRICT when absent, so a
      // registration written before policies existed keeps exactly the rule it
      // was written under, and a wider rule is something an entry has to ask
      // for in writing.
      expect([...parseRegisteredClients(one).values()]).toEqual([
        { ...entry, callbackPolicy: "loopback-ip" },
      ]);
    });

    it("registers a client whose family is not one of the three presets", () => {
      // THE POINT OF THE GENERIC CHANGE. ArtVenn is a tool service, not a
      // client directory: a new approved client is a registration, not a
      // schema change. The family is a label; the identity is the client id.
      const generic = {
        ...entry,
        clientId: "artvenn-generic-01",
        family: "some-new-agent",
        label: "Some new agent",
      };
      expect(
        parseRegisteredClients(JSON.stringify([generic])).get(
          "artvenn-generic-01",
        )?.family,
      ).toBe("some-new-agent");
    });

    it("still bounds the family, because it is templated into the principal label", () => {
      // `principal_label` is `agent-<family>-<12 hex>` and its CHECK is
      // ^agent-[a-z0-9-]{2,57}$. A family that broke that shape would produce
      // a connection the database refuses, or worse, a label that collides.
      for (const family of [
        "",
        "-leading-dash",
        "Upper",
        "with_underscore",
        "with space",
        "a".repeat(33),
      ])
        expect(() =>
          parseRegisteredClients(JSON.stringify([{ ...entry, family }])),
        ).toThrow(RegisteredClientError);
    });

    it("refuses a redirect target that is not loopback", () => {
      // A redirect target is where an authorization code is delivered, so a
      // registry that accepted a remote host would be the weakest link in the
      // whole flow.
      for (const redirect of [
        "https://elsewhere.invalid/callback",
        "http://192.168.1.10:8080/callback",
        "http://127.0.0.1:34699/callback#fragment",
        "http://user@127.0.0.1:34699/callback",
        "not a url",
        // The default policy does not admit the NAME, only the addresses.
        "http://localhost:8787/callback",
        // Never a bare root: it is the closest thing a URL path has to a
        // wildcard, and it accepts every deep link built under it later.
        "http://127.0.0.1:34699/",
        // Never a query: the provider appends its own, and a registration
        // carrying one is a registration that will not match.
        "http://127.0.0.1:34699/callback?x=1",
        // Always an explicit port, so the entry says what it means.
        "http://127.0.0.1/callback",
      ])
        expect(() =>
          parseRegisteredClients(
            JSON.stringify([{ ...entry, redirectUris: [redirect] }]),
          ),
        ).toThrow(RegisteredClientError);
      expect(() =>
        parseRegisteredClients(
          JSON.stringify([{ ...entry, redirectUris: [] }]),
        ),
      ).toThrow(RegisteredClientError);
    });

    it("admits the localhost spelling only for a registration that asks for it", () => {
      // Cursor Desktop publishes exactly this callback, so refusing the
      // spelling refuses the client. It is a POLICY ON THE REGISTRATION, never
      // a branch on the family: a rule that reads `family === "cursor"` has to
      // be edited for the next client and makes a label decide a security
      // question.
      const cursor = {
        clientId: "artvenn-cursor-01",
        family: "cursor",
        label: "Cursor",
        callbackPolicy: "loopback-host",
        redirectUris: ["http://localhost:8787/callback"],
      };
      expect(
        parseRegisteredClients(JSON.stringify([cursor])).get(
          "artvenn-cursor-01",
        )?.redirectUris,
      ).toEqual(["http://localhost:8787/callback"]);

      // The wider policy widens the HOST and nothing else.
      for (const redirect of [
        "https://localhost:8787/callback",
        "http://localhost.evil.invalid:8787/callback",
        "http://notlocalhost:8787/callback",
        "http://localhost:8787/callback#f",
        "http://localhost/callback",
        "http://localhost:8787/",
      ])
        expect(() =>
          parseRegisteredClients(
            JSON.stringify([{ ...cursor, redirectUris: [redirect] }]),
          ),
        ).toThrow(RegisteredClientError);

      // And a spelling is never rewritten into the other one: the stored form
      // is byte-identical to what was registered.
      expect(
        parseRegisteredClients(
          JSON.stringify([
            { ...cursor, redirectUris: ["http://127.0.0.1:8787/callback"] },
          ]),
        ).get("artvenn-cursor-01")?.redirectUris,
      ).toEqual(["http://127.0.0.1:8787/callback"]);
    });

    describe("the hosted-https policy", () => {
      const hosted = {
        clientId: "https://tool.invalid/oauth/client.json",
        family: "some-tool",
        label: "Some tool",
        callbackPolicy: "hosted-https",
        redirectUris: ["https://tool.invalid/api/mcp/auth_callback"],
      };
      const parseHosted = (redirectUris: unknown) =>
        parseRegisteredClients(JSON.stringify([{ ...hosted, redirectUris }]), {
          allowHosted: true,
        });
      const codeOf = (run: () => unknown): string | undefined => {
        try {
          run();
        } catch (error) {
          expect(error).toBeInstanceOf(RegisteredClientError);
          return (error as RegisteredClientError).code;
        }
        return undefined;
      };

      it("is refused unless the caller allows it, so Article stays loopback only", () => {
        // The default is the point: a caller that says nothing never accepts a
        // remote callback, however well formed the entry is.
        for (const options of [undefined, {}, { allowHosted: false }])
          expect(
            codeOf(() =>
              parseRegisteredClients(JSON.stringify([hosted]), options),
            ),
          ).toBe("CLIENTS_HOSTED_NOT_ALLOWED");
      });

      it("reads the first list exactly as the record states it", () => {
        const list = [
          {
            clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
            family: "claude",
            label: "Claude",
            callbackPolicy: "hosted-https",
            redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
          },
          {
            clientId: "https://claude.ai/oauth/claude-code-client-metadata",
            family: "claude-code",
            label: "Claude Code",
            callbackPolicy: "loopback-host",
            redirectUris: [
              "http://localhost:49152/callback",
              "http://127.0.0.1:49152/callback",
            ],
          },
          {
            clientId: "https://chatgpt.com/oauth/codex/client.json",
            family: "codex",
            label: "Codex",
            callbackPolicy: "loopback-host",
            redirectUris: [
              "http://127.0.0.1:49152/callback",
              "http://localhost:49152/callback",
            ],
          },
          {
            clientId: "https://chatgpt.com/oauth/client.json",
            family: "chatgpt",
            label: "ChatGPT",
            callbackPolicy: "hosted-https",
            redirectUris: [
              "https://chatgpt.com/connector_platform_oauth_redirect",
            ],
          },
        ];
        expect([
          ...parseRegisteredClients(JSON.stringify(list), {
            allowHosted: true,
          }).values(),
        ]).toEqual(list);
      });

      it("takes one exact https URL on a named host, and refuses every other spelling", () => {
        expect(codeOf(() => parseHosted(hosted.redirectUris))).toBeUndefined();
        for (const redirect of [
          // Scheme.
          "http://tool.invalid/callback",
          // No port, not even the default one the parser would drop.
          "https://tool.invalid:8443/callback",
          "https://tool.invalid:443/callback",
          // No query, no fragment, no userinfo: none of them can be matched
          // exactly against what the provider appends or the URL parser strips.
          "https://tool.invalid/callback?x=1",
          "https://tool.invalid/callback?",
          "https://tool.invalid/callback#fragment",
          "https://tool.invalid/callback#",
          "https://user@tool.invalid/callback",
          `https://${["user", "other"].join(":")}@tool.invalid/callback`,
          // A real path.
          "https://tool.invalid/",
          "https://tool.invalid",
          // Written exactly as it round-trips.
          "https://TOOL.invalid/callback",
          "https://tool.invalid/a/../callback",
          // A named public host: never loopback, an address or a bare name.
          "https://localhost/callback",
          "https://127.0.0.1/callback",
          "https://[::1]/callback",
          "https://203.0.113.9/callback",
          "https://intranet/callback",
        ])
          expect([redirect, codeOf(() => parseHosted([redirect]))]).toEqual([
            redirect,
            "CLIENTS_REDIRECT_NOT_HOSTED",
          ]);
        expect(codeOf(() => parseHosted(["not a url"]))).toBe(
          "CLIENTS_MALFORMED",
        );
        expect(codeOf(() => parseHosted([]))).toBe("CLIENTS_MALFORMED");
      });

      it("refuses a second callback, on another host or on the same one", () => {
        for (const second of [
          "https://other-vendor.invalid/callback",
          "https://tool.invalid/other-callback",
        ])
          expect(
            codeOf(() => parseHosted([...hosted.redirectUris, second])),
          ).toBe("CLIENTS_REDIRECT_NOT_HOSTED");
      });

      it("leaves the loopback policies as they were when the caller allows hosted", () => {
        // Allowing a hosted entry widens nothing for an entry that did not ask.
        expect(
          codeOf(() =>
            parseRegisteredClients(
              JSON.stringify([
                { ...entry, redirectUris: ["https://tool.invalid/callback"] },
              ]),
              { allowHosted: true },
            ),
          ),
        ).toBe("CLIENTS_REDIRECT_NOT_LOOPBACK");
        expect(
          codeOf(() =>
            parseRegisteredClients(
              JSON.stringify([
                {
                  ...entry,
                  callbackPolicy: "loopback-host",
                  redirectUris: ["https://tool.invalid/callback"],
                },
              ]),
              { allowHosted: true },
            ),
          ),
        ).toBe("CLIENTS_REDIRECT_NOT_LOOPBACK");
      });
    });

    it("refuses an unknown callback policy rather than falling back to one", () => {
      for (const callbackPolicy of ["", "anything", "loopback", 1, null])
        expect(() =>
          parseRegisteredClients(
            JSON.stringify([{ ...entry, callbackPolicy }]),
          ),
        ).toThrow(RegisteredClientError);
    });

    it("refuses rather than skipping, because a dropped client is a blank screen the provider will still authorize", () => {
      for (const value of [
        "",
        "[]",
        "{}",
        JSON.stringify([{ clientId: "a", family: "claude" }]),
        JSON.stringify([{ ...entry, extra: 1 }]),
        JSON.stringify([{ ...entry, label: " x" }]),
        JSON.stringify([{ ...entry, clientId: "" }]),
      ])
        expect(() => parseRegisteredClients(value)).toThrow(
          RegisteredClientError,
        );
    });

    it("refuses a duplicated client id instead of letting the last entry win", () => {
      expect(() =>
        parseRegisteredClients(
          JSON.stringify([
            { ...entry, label: "First" },
            { ...entry, family: "codex", label: "Second" },
          ]),
        ),
      ).toThrow(RegisteredClientError);
    });
  });

  it("keeps the interaction uid opaque wherever it is parsed", () => {
    expect(interactionUidSchema.safeParse("a".repeat(256)).success).toBe(true);
    expect(interactionUidSchema.safeParse("a".repeat(257)).success).toBe(false);
    expect(digestConsentTicket("x")).toMatch(/^[0-9a-f]{64}$/u);
  });
});
