export interface FieldError {
  field: string;
  message: string;
}

/**
 * An error the caller can act on. Throw this from services with a stable `code` that clients can
 * switch on; the message is for people and may change.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly fieldErrors?: FieldError[],
    readonly headers?: Record<string, string>,
    /** Extra facts a client can use, such as the existing record behind a duplicate. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(code: string, message: string, fieldErrors?: FieldError[]): AppError {
    return new AppError(code, message, 400, fieldErrors);
  }
  static unauthorized(message = 'Authentication is required'): AppError {
    return new AppError('UNAUTHENTICATED', message, 401);
  }
  static forbidden(code = 'FORBIDDEN', message = 'You do not have permission to do this'): AppError {
    return new AppError(code, message, 403);
  }
  static notFound(what = 'Record'): AppError {
    return new AppError('NOT_FOUND', `${what} was not found`, 404);
  }
  static conflict(code: string, message: string, details?: Record<string, unknown>): AppError {
    return new AppError(code, message, 409, undefined, undefined, details);
  }
}
