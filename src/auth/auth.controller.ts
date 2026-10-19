import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { AuthContext, CurrentUser, Public } from "../common/decorators";
import { AuthService } from "./auth.service";
import { AcceptInviteDto, LoginDto, RefreshDto, RegisterDto } from "./dto/auth.dto";

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

  @Public() @HttpCode(204) @Post("logout")
  async logout(@Body() dto: RefreshDto) { await this.auth.logout(dto.refreshToken); }

  @ApiBearerAuth() @Get("me")
  me(@CurrentUser() user: AuthContext) { return this.auth.me(user.userId); }
}
