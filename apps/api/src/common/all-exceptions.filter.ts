import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorBody, mapError } from './error-mapping.js';

/** Every error leaves the API in the same shape, with the request id for support. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();
    const mapped = mapError(exception);

    if (mapped.unexpected) {
      this.logger.error(
        { requestId: request.id, method: request.method, url: request.url, code: mapped.code },
        exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
      );
    }

    const body: ErrorBody = {
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.fieldErrors?.length ? { fieldErrors: mapped.fieldErrors } : {}),
        ...(mapped.details ? { details: mapped.details } : {}),
        requestId: request.id,
      },
    };
    for (const [name, value] of Object.entries(mapped.headers ?? {})) void reply.header(name, value);
    this.adapterHost.httpAdapter.reply(reply, body, mapped.status);
  }
}
