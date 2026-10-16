import { AuthPage } from "../../features/auth/auth-page";
import { safeReturnPath } from "../../features/auth/auth-api";
import { WideScreenAuthRedirect } from "../../features/auth/wide-screen-auth-redirect";
import { readAuthPageWideScreenRedirect } from "../wide-screen-browse-only";

export default async function RegisterPage({
  searchParams,
}: {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}) {
  const [params, redirectWideScreen] = await Promise.all([
    searchParams,
    readAuthPageWideScreenRedirect(),
  ]);
  const query = params ?? {};
  const returnTo = safeReturnPath(
    typeof query.return === "string" ? query.return : "/",
  );
  return (
    <>
      {redirectWideScreen ? <WideScreenAuthRedirect /> : null}
      <AuthPage mode="register" returnTo={returnTo} />
    </>
  );
}
