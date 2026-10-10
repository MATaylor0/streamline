/**
 * Transport-neutral errors. The REST layer maps `status` to HTTP codes, the MCP
 * layer turns them into tool errors, the CLI prints them.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('validation_error', message, 400, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super('unauthorized', message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super('forbidden', message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super('not_found', id ? `${entity} '${id}' not found` : `${entity} not found`, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super('conflict', message, 409, details);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests') {
    super('rate_limited', message, 429);
  }
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === '23505' || e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(e?.message ?? '');
}
