import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import type { Role } from "@prisma/client";

export const IS_PUBLIC = "isPublic";
export const ROLES = "roles";

/** Skips the JWT guard (storefront, auth, pricing). Public routes are still rate-limited. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Restricts a route to the given roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export interface AuthContext {
  userId: string;
  role: Role;
  /** Set for business admins; always comes from the verified token, never from the request. */
  businessId?: string;
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext =>
  ctx.switchToHttp().getRequest().user);
