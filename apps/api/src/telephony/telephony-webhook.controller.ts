import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { Public } from '../auth/decorators.js';
import { TelephonyKeyGuard } from './telephony-key.guard.js';
import { TelephonyWebhookService } from './telephony-webhook.service.js';

/** Where the telephony provider reports calls. The company is known from the key, not from the body. */
@ApiTags('telephony')
@ApiSecurity('webhook-key')
@Public()
@UseGuards(TelephonyKeyGuard)
@Controller('telephony')
export class TelephonyWebhookController {
  constructor(private readonly webhook: TelephonyWebhookService) {}

  /** 200 when the events were applied or had been applied before; 422 when the body is not understood; 5xx makes the provider retry. */
  @Post('webhook')
  @HttpCode(200)
  receive(@Req() req: FastifyRequest, @Body() body: unknown) {
    return this.webhook.receive(req.telephony!, body);
  }
}
