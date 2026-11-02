import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
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

  /** For providers that cannot send headers: the key is the last part of the address. The provider named there must be the company's own. */
  @Post('hooks/:provider/:key')
  @HttpCode(200)
  receiveByAddress(@Req() req: FastifyRequest, @Param('provider') provider: string, @Body() body: unknown) {
    return this.webhook.receive(req.telephony!, body, provider);
  }

  /** The same, for providers that report with a GET request and put the call details in the query string. */
  @Get('hooks/:provider/:key')
  @HttpCode(200)
  receiveByQuery(@Req() req: FastifyRequest, @Param('provider') provider: string, @Query() query: unknown) {
    return this.webhook.receive(req.telephony!, query, provider);
  }
}
