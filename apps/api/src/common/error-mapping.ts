import { HttpException, HttpStatus } from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';
import { AppError, FieldError } from './app-error.js';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    fieldErrors?: FieldError[];
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export interface MappedError {
  status: number;
  code: string;
  message: string;
  fieldErrors?: FieldError[];
  headers?: Record<string, string>;
  details?: Record<string, unknown>;
  /** True when this is our fault, so it is logged with its stack trace. */
  unexpected: boolean;
}

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  408: 'REQUEST_TIMEOUT',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
};

const INTERNAL: MappedError = {
  status: 500,
  code: 'INTERNAL',
  message: 'Something went wrong on our side. Please try again, and quote the request id if it continues.',
  unexpected: true,
};

interface PgLikeError {
  code?: string;
  constraint?: string;
}

function isPgError(err: unknown): err is PgLikeError & Error {
  return err instanceof Error && typeof (err as PgLikeError).code === 'string' && /^[0-9A-Z]{5}$/.test((err as PgLikeError).code!);
}

function zodFieldErrors(err: unknown): FieldError[] {
  const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] })?.issues ?? [];
  return issues.map((i) => ({ field: i.path.map(String).join('.') || '(body)', message: i.message }));
}

/**
 * Turns anything that can be thrown into one predictable shape. Database errors are translated by
 * their SQLSTATE class so a duplicate phone number is a 409, not a 500, and internal detail such as
 * table and constraint names never reaches the client.
 */
export function mapError(err: unknown): MappedError {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message, fieldErrors: err.fieldErrors, headers: err.headers, details: err.details, unexpected: false };
  }

  if (err instanceof ZodValidationException) {
    return {
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'Some of the details are not valid',
      fieldErrors: zodFieldErrors(err.getZodError()),
      unexpected: false,
    };
  }

  if (err instanceof HttpException) {
    const status = err.getStatus();
    const response = err.getResponse();
    const message =
      typeof response === 'string'
        ? response
        : ((response as { message?: string | string[] }).message ?? err.message);
    return {
      status,
      code: STATUS_CODES[status] ?? 'ERROR',
      message: Array.isArray(message) ? message.join('; ') : message,
      unexpected: status >= 500,
    };
  }

  if (isPgError(err)) {
    switch (err.code) {
      case '23505':
        return { status: 409, code: 'DUPLICATE', message: 'A record with these details already exists', unexpected: false };
      case '23503':
        return {
          status: 409,
          code: 'REFERENCE_CONFLICT',
          message: 'This record refers to, or is used by, another record, so the change was not allowed',
          unexpected: false,
        };
      case '23514':
      case '23P01':
        return { status: 422, code: 'RULE_VIOLATION', message: 'The details break a rule of the system', unexpected: false };
      case '42501':
        return { status: 403, code: 'FORBIDDEN', message: 'You do not have permission to do this', unexpected: false };
      case '40001':
      case '40P01':
        return { status: 503, code: 'RETRY', message: 'The system was busy. Please try again.', headers: { 'retry-after': '1' }, unexpected: false };
      case '57014':
        return { status: 503, code: 'TIMEOUT', message: 'The request took too long. Please try again.', headers: { 'retry-after': '2' }, unexpected: true };
      default:
        if (err.code?.startsWith('08') || err.code?.startsWith('53') || err.code?.startsWith('57')) {
          return { status: 503, code: 'UNAVAILABLE', message: 'The service is temporarily unavailable', headers: { 'retry-after': '5' }, unexpected: true };
        }
        return INTERNAL;
    }
  }

  // Errors raised by the web server itself, such as invalid JSON or a body that is too large.
  const web = err as { statusCode?: unknown; code?: unknown; message?: unknown };
  if (typeof web?.statusCode === 'number' && web.statusCode >= 400 && web.statusCode < 500 && typeof web.code === 'string' && web.code.startsWith('FST_')) {
    const status = web.statusCode;
    return {
      status,
      code: STATUS_CODES[status] ?? 'BAD_REQUEST',
      message: status === HttpStatus.PAYLOAD_TOO_LARGE ? 'The request is too large' : 'The request could not be read',
      unexpected: false,
    };
  }

  if ((err as NodeJS.ErrnoException)?.code === 'ECONNREFUSED') {
    return { status: 503, code: 'UNAVAILABLE', message: 'The service is temporarily unavailable', headers: { 'retry-after': '5' }, unexpected: true };
  }

  return INTERNAL;
}
