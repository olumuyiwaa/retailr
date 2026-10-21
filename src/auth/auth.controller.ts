import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { AuthContext, CurrentUser, Public } from "../common/decorators";
import { AuthService } from "./auth.service";
import { AcceptInviteDto, ForgotPasswordDto, LoginDto, RefreshDto, RegisterDto, ResetPasswordDto, VerifyEmailDto } from "./dto/auth.dto";

/** Credential endpoints: 10 per minute per client by default (AUTH_RATE_LIMIT overrides it, mainly for tests). */
const strict = { default: { limit: () => Number(process.env.AUTH_RATE_LIMIT ?? 10), ttl: 60_000 } };

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @Throttle(strict) @Post("register")
  register(@Body() dto: RegisterDto) { return this.auth.register(dto); }

  @Public() @Throttle(strict) @HttpCode(200) @Post("login")
  login(@Body() dto: LoginDto) { return this.auth.login(dto.email, dto.password); }

  @Public() @Throttle(strict) @HttpCode(200) @Post("refresh")
  refresh(@Body() dto: RefreshDto) { return this.auth.refresh(dto.refreshToken); }

  @Public() @Throttle(strict) @Get("invite/:token")
  invite(@Param("token") token: string) { return this.auth.invitePreview(token); }

  @Public() @Throttle(strict) @HttpCode(200) @Post("accept-invite")
  accept(@Body() dto: AcceptInviteDto) { return this.auth.acceptInvite(dto.token, dto.password); }

  @Public() @Throttle(strict) @HttpCode(204) @Post("forgot-password")
  async forgot(@Body() dto: ForgotPasswordDto) { await this.auth.forgotPassword(dto.email); }

  @Public() @Throttle(strict) @HttpCode(204) @Post("reset-password")
  async reset(@Body() dto: ResetPasswordDto) { await this.auth.resetPassword(dto.token, dto.password); }

  @Public() @Throttle(strict) @HttpCode(204) @Post("verify-email")
  async verify(@Body() dto: VerifyEmailDto) { await this.auth.verifyEmail(dto.token); }

  @ApiBearerAuth() @Throttle(strict) @HttpCode(204) @Post("resend-verification")
  async resend(@CurrentUser() user: AuthContext) { await this.auth.resendVerification(user.userId); }

  @Public() @HttpCode(204) @Post("logout")
  async logout(@Body() dto: RefreshDto) { await this.auth.logout(dto.refreshToken); }

  @ApiBearerAuth() @Get("me")
  me(@CurrentUser() user: AuthContext) { return this.auth.me(user.userId); }
}
