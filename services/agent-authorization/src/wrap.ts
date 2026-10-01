import type {
  OidcProvider,
  ProviderBundle,
  ProviderContext,
} from "./provider.js";

/**
 * Agent Connections V1 (Issue #141 r15 §5) — Design B at runtime.
 *
 * `oidc-provider@9.12.2` cannot be made to emit a prefixed access token: r11
 * established that `formats.AccessToken` is unreferenced, `generateTokenId` is
 * not configurable and the opaque generator returns a bare nanoid. So the
 * token endpoint's successful responses are post-processed and the access
 * token replaced with an ArtVenn-minted opaque value whose mapping is bound to
 * the consent grant.
 *
 * Four things here are the difference between this and a token leak:
 *
 *  1. **Match `ctx.oidc.route`, never a path suffix.** A suffix test fails
 *     OPEN: if the route ever moves it silently stops matching and ships the
 *     raw provider token to the client.
 *  2. **No canonical consent row means no wrapper**, and no wrapper means the
 *     response must not go out. A wrapper bound to nothing is a token with no
 *     revocation story.
 *  3. **A persistence failure destroys what was issued and refuses.** Falling
 *     through would return the provider's own bearer as if it were ours.
 *  4. **The provenance is never taken from the request.** `mint` derives the
 *     connection and the consent generation from the grant row itself, so a
 *     parameter the Agent controls cannot influence what a token is bound to.
 */

export interface WrapDiagnostics {
  /** Optional public-user policy; default preserves existing Admin wrapping. */
  readonly assertGrantCurrent?: (grantId: string) => Promise<void>;
  /** Bare codes only. Never a token, never a jti, never a grant id. */
  readonly recordFailure?: (code: string) => void;
}

export const installAccessTokenWrapper = (
  bundle: Pick<ProviderBundle, "provider" | "wrappers">,
  diagnostics: WrapDiagnostics = {},
): void => {
  const { provider, wrappers } = bundle;

  provider.use(async (ctx: ProviderContext, next: () => Promise<void>) => {
    await next();

    if (ctx.oidc?.route !== "token" || ctx.status !== 200) return;
    const body = ctx.body;
    if (body === undefined || typeof body.access_token !== "string") return;

    const issued = body.access_token;
    let grantId: string | undefined;
    try {
      const token = await provider.AccessToken.find(issued);
      grantId = typeof token?.grantId === "string" ? token.grantId : undefined;
    } catch {
      grantId = undefined;
    }

    const refuse = (code: string) => {
      diagnostics.recordFailure?.(code);
      // Destroy what was just issued rather than leave a live provider token
      // that nothing on our side can revoke, then refuse. One sympathetic
      // `catch` upstream returning the original body is exactly the shape
      // this ordering exists to prevent.
      void provider.AccessToken.revokeByGrantId?.(grantId ?? "").catch(
        () => undefined,
      );
      ctx.status = 500;
      ctx.body = undefined;
    };

    if (grantId === undefined) return refuse("WRAP_NO_PROVIDER_GRANT");

    try {
      await diagnostics.assertGrantCurrent?.(grantId);
      const minted = await wrappers.mint({
        grantId,
        jti: issued,
        expiresAt: new Date(Date.now() + (body.expires_in ?? 300) * 1000),
      });
      // The only mutation: the client receives our opaque value and never the
      // provider's. Everything else about the response framing — token_type,
      // expires_in, scope, refresh_token — is left exactly as the provider
      // built it.
      body.access_token = minted.presented;
    } catch {
      return refuse("WRAP_PERSISTENCE_FAILED");
    }
  });
};

/** Destroying a provider grant, in the shape the grant destroyer expects. */
export const providerGrantLifecycle = (provider: OidcProvider) => ({
  destroyGrant: async (grantId: string): Promise<void> => {
    const grant = (
      provider as unknown as {
        Grant: { adapter: { destroy: (id: string) => Promise<void> } };
      }
    ).Grant;
    await grant.adapter.destroy(grantId);
  },
  revokeIssued: async (grantId: string): Promise<void> => {
    await provider.AccessToken.revokeByGrantId?.(grantId);
    await provider.RefreshToken.revokeByGrantId?.(grantId);
  },
  isAbsent: async (grantId: string): Promise<boolean> => {
    const grant = (
      provider as unknown as {
        Grant: { adapter: { find: (id: string) => Promise<unknown> } };
      }
    ).Grant;
    return (await grant.adapter.find(grantId)) === undefined;
  },
});
