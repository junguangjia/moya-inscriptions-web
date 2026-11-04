import { APIError } from "payload";

export class EditorialError extends APIError {
  readonly code: string;
  readonly fields: string[];

  constructor(code: string, status = 400, fields: string[] = []) {
    super(code, status, { code, fields }, true);
    this.code = code;
    this.fields = fields;
  }
}

/** Never include validator messages, values, database errors, or URLs. */
export const validationError = (issues: readonly { path: PropertyKey[] }[]) =>
  new EditorialError("CONTENT_INVALID", 400, [
    ...new Set(issues.map(({ path }) => String(path[0] ?? "content"))),
  ]);

export const safeEditorialFailure = (error: unknown) => ({
  ok: false as const,
  error:
    error instanceof EditorialError
      ? {
          code: error.code,
          fields: error.fields,
          ...("replayed" in error ? { replayed: true } : {}),
        }
      : { code: "OPERATION_FAILED", fields: [] as string[] },
});
