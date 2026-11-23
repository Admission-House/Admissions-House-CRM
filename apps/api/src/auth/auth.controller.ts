import { COMPUTER_TOKEN, newComputerToken } from './office-computers.service.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import type { AuthContext } from './auth-context.js';
import { AuthService, RequestMeta, SignedIn } from './auth.service.js';
import { AllowMfaSetup, AllowPasswordChange, CurrentAuth, Public, RequirePermissions } from './decorators.js';
import { ChangePasswordDto, ForgotPasswordDto, LoginDto, RefreshDto, ResetPasswordDto } from './dto/auth.dto.js';
import { PasswordResetService } from './password-reset.service.js';

const REFRESH_COOKIE = 'ah_rt';
/** The protected cookie that holds a browser's own random token, so the CRM can tell it is the same computer next time. */
const COMPUTER_COOKIE = 'ah_oc';
const COMPUTER_COOKIE_DAYS = 180;
const COOKIE_PATH = '/api/v1/auth';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly resets: PasswordResetService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: LoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const meta = this.meta(req);
    if (body.clientType === 'web') meta.computerToken = this.computerToken(req, reply);
    const result = await this.auth.login(body, meta);
    const { refreshToken, ...rest } = result;
    this.noStore(reply);
    return { ...rest, ...this.deliverRefreshToken(reply, result.clientType, refreshToken) };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() body: RefreshDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const token = body.refreshToken ?? req.cookies?.[REFRESH_COOKIE];
    const result: SignedIn = await this.auth.refresh(token, this.meta(req));
    this.noStore(reply);
    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      ...(result.refreshToken ? this.deliverRefreshToken(reply, result.clientType, result.refreshToken) : {}),
    };
  }

  @ApiBearerAuth()
  @AllowPasswordChange()
  @AllowMfaSetup()
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.auth.logout(auth);
    void reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  }

  /**
   * The person is working on the page (typing, clicking, scrolling) without anything being saved. Answers nothing; passing
   * the sign-in check is what counts as activity, so reading a lead does not end in an idle sign-out.
   */
  @ApiBearerAuth()
  @AllowPasswordChange()
  @AllowMfaSetup()
  @Post('activity')
  @HttpCode(204)
  activity(): void {
    return;
  }

  /** The signed-in user, their permissions and the company. Also serves as the activity heartbeat. */
  @ApiBearerAuth()
  @AllowPasswordChange()
  @AllowMfaSetup()
  @Get('me')
  me(@CurrentAuth() auth: AuthContext) {
    return this.auth.profile(auth);
  }

  /** Always answers the same way, whether or not the address has an account. */
  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(@Body() body: ForgotPasswordDto, @Req() req: FastifyRequest) {
    await this.resets.request(body, req.ip);
    return { message: 'If this address has an account, an email with a reset link is on its way.' };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Body() body: ResetPasswordDto, @Req() req: FastifyRequest) {
    await this.resets.reset(body, req.ip);
    return { message: 'Your password has been changed. Sign in with the new one.' };
  }

  @ApiBearerAuth()
  @AllowPasswordChange()
  @AllowMfaSetup()
  @Post('change-password')
  @HttpCode(200)
  changePassword(@CurrentAuth() auth: AuthContext, @Body() body: ChangePasswordDto) {
    return this.auth.changePassword(auth, body);
  }

  @ApiBearerAuth()
  @Get('sessions')
  sessions(@CurrentAuth() auth: AuthContext) {
    return this.auth.listSessions(auth);
  }

  /** Every active session in the company. Only for those who manage users. */
  @ApiBearerAuth()
  @RequirePermissions('user.manage')
  @Get('sessions/all')
  allSessions(@CurrentAuth() auth: AuthContext, @Query('userId') userId?: string) {
    return this.auth.listTenantSessions(auth, userId && /^[0-9a-f-]{36}$/i.test(userId) ? userId : undefined);
  }

  @ApiBearerAuth()
  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    if (id === auth.sessionId) throw AppError.badRequest('USE_LOGOUT', 'Use sign out to end this session');
    await this.auth.revokeSession(auth, id);
  }

  /**
   * This browser's token for its own computer: the one it already holds, or a new random one given now (also when the sign-in
   * is refused, so a request for approval made by this browser is recognised when it tries again). It is only a name for the
   * browser; it grants nothing until a person or an office address has vouched for it on the server.
   */
  private computerToken(req: FastifyRequest, reply: FastifyReply): string {
    const held = req.cookies?.[COMPUTER_COOKIE];
    if (held && COMPUTER_TOKEN.test(held)) return held;
    const token = newComputerToken();
    void reply.setCookie(COMPUTER_COOKIE, token, {
      httpOnly: true,
      secure: this.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: COOKIE_PATH,
      maxAge: COMPUTER_COOKIE_DAYS * 86400,
    });
    return token;
  }

  private meta(req: FastifyRequest): RequestMeta {
    return { ip: req.ip, userAgent: req.headers['user-agent'] ?? null, requestId: req.id };
  }

  /** Tokens must never be stored by a browser or a proxy. */
  private noStore(reply: FastifyReply): void {
    void reply.header('cache-control', 'no-store');
  }

  /** The web gets the refresh token in a protected cookie; the mobile app gets it in the body. */
  private deliverRefreshToken(
    reply: FastifyReply,
    clientType: 'web' | 'mobile',
    token: string,
  ): { refreshToken?: string } {
    if (clientType === 'mobile') return { refreshToken: token };
    void reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: COOKIE_PATH,
      maxAge: this.env.SESSION_MAX_HOURS * 3600,
    });
    return {};
  }
}
