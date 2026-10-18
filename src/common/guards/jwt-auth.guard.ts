import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { AuthContext, IS_PUBLIC, ROLES } from "../decorators";
import { AppError } from "../errors";
import { PrismaService } from "../../prisma/prisma.service";
import type { Role } from "@prisma/client";

interface AccessPayload { sub: string; role: Role; businessId?: string }

/**
 * Global guard: verifies the bearer token, locks out suspended/cancelled businesses immediately,
 * and enforces @Roles. A route is private unless it is marked @Public().
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly jwt: JwtService, private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) throw AppError.unauthorized();

    let payload: AccessPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessPayload>(token);
    } catch {
      throw AppError.unauthorized("Your session has expired. Please sign in again.", "TOKEN_EXPIRED");
    }

    if (payload.role === "BUSINESS_ADMIN") {
      if (!payload.businessId) throw AppError.unauthorized();
      const biz = await this.prisma.business.findUnique({ where: { id: payload.businessId }, select: { status: true } });
      if (!biz) throw AppError.unauthorized();
      if (biz.status === "SUSPENDED") throw AppError.forbidden("This business account is suspended. Contact Retailr support.", "BUSINESS_SUSPENDED");
      if (biz.status === "CANCELLED") throw AppError.forbidden("This business account has been cancelled.", "BUSINESS_CANCELLED");
    }

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (required?.length && !required.includes(payload.role)) throw AppError.forbidden("You don't have access to that.");

    const auth: AuthContext = { userId: payload.sub, role: payload.role, businessId: payload.businessId };
    req.user = auth;
    return true;
  }
}
