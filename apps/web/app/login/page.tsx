import { AuthPage } from "../../features/auth/auth-page";
import { safeReturnPath } from "../../features/auth/auth-api";

export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}) {
  const query = (await searchParams) ?? {};
  const returnTo = safeReturnPath(
    typeof query.return === "string" ? query.return : "/",
  );
  return <AuthPage mode="sign-in" returnTo={returnTo} />;
}
