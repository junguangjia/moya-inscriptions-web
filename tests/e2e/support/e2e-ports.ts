const readPort = (
  value: string | undefined,
  fallback: number,
  name: string,
) => {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be an integer port`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be between 1 and 65535`);
  }
  return port;
};

/** Test-service ports only; the existing default runtime stays unchanged. */
export const readE2ePorts = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const web = readPort(
    environment.MOYA_E2E_WEB_PORT,
    3100,
    "MOYA_E2E_WEB_PORT",
  );
  const publicApi = readPort(
    environment.MOYA_E2E_PUBLIC_API_PORT,
    3101,
    "MOYA_E2E_PUBLIC_API_PORT",
  );
  if (web === publicApi)
    throw new Error("E2E Web and Public API ports must differ");
  return { web, publicApi };
};

export const readPagingWebPort = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const port = readPort(
    environment.MOYA_E2E_PAGING_WEB_PORT,
    3210,
    "MOYA_E2E_PAGING_WEB_PORT",
  );
  const { web, publicApi } = readE2ePorts(environment);
  if (port === web || port === publicApi)
    throw new Error("Paging Web must have a separate test-service port");
  return port;
};
