import type { z } from "zod";

/** A problem the user can understand and fix. Safe to show on screen. */
export class DomainError extends Error {
  constructor(
    message: string,
    public fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class ForbiddenError extends DomainError {
  constructor() {
    super("You do not have permission to do this.");
    this.name = "ForbiddenError";
  }
}

export function fieldError(field: string, message: string): DomainError {
  return new DomainError("Please check the highlighted field.", { [field]: message });
}

export function parseInput<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    fieldErrors[String(issue.path[0] ?? "form")] ??= issue.message;
  }
  throw new DomainError("Please check the highlighted fields.", fieldErrors);
}

type PgError = { code: string; constraint_name?: string };

/** Drizzle wraps driver errors, so look through the cause chain. */
export function asPgError(error: unknown): PgError | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const candidate = current as Partial<PgError> & { cause?: unknown };
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return candidate as PgError;
    }
    current = candidate.cause;
  }
  return null;
}

/** Turns a named database constraint failure into a message for the user. */
export function rethrowConstraint(
  error: unknown,
  messages: Record<string, DomainError>,
): never {
  const pg = asPgError(error);
  const mapped = pg?.constraint_name ? messages[pg.constraint_name] : undefined;
  throw mapped ?? error;
}
