import { Body, Controller, Headers, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../auth/decorators.js';
import { AppError } from '../common/app-error.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { IntakeService } from './intake.service.js';

/**
 * Where lead sources send leads: the company website's form, an ads lead form through a connector,
 * a partner portal. The source is known from the API key, not from anything in the payload.
 */
@ApiTags('intake')
@ApiSecurity('api-key')
@Public()
@UseGuards(ApiKeyGuard)
@Controller('intake')
export class IntakeController {
  constructor(private readonly intake: IntakeService) {}

  /**
   * 201 a new lead was made; 200 it was added to an existing lead (same phone), refused by the
   * company's policy, or is a delivery already seen; 202 saved and will be filed shortly;
   * 422 the content cannot be a lead (for example, no usable phone number).
   * Send an Idempotency-Key header so that a retry never makes a second lead.
   */
  @Post('leads')
  @HttpCode(200)
  async receive(
    @Req() req: FastifyRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const outcome = await this.intake.receive(req.intake!, body, idempotencyKey);
    switch (outcome.kind) {
      case 'done':
        void reply.code(outcome.result.outcome === 'created' && !outcome.replay ? 201 : 200);
        return { ...outcome.result, replay: outcome.replay };
      case 'queued':
        void reply.code(202);
        return { outcome: 'queued', eventId: outcome.eventId };
      case 'invalid':
        throw new AppError('INVALID_LEAD', 'The lead could not be read', 422, outcome.errors);
    }
  }
}
