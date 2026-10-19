import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import type { Role } from "@prisma/client";

export const IS_PUBLIC = "isPublic";
export const ROLES = "roles";

/** Skips the JWT guard (storefront, auth, pricing). Public routes are still rate-limited. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Restricts a route to the given roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export type TeamLevel = "STAFF" | "MANAGER" | "OWNER";
export const TEAM_LEVEL = "teamLevel";
/**
 * The lowest team role that may use a business route (STAFF < MANAGER < OWNER). Routes without it are open to every team member.
 * Put on a method it wins over the same decorator on the class.
 */
export const MinRole = (level: TeamLevel) => SetMetadata(TEAM_LEVEL, level);
export const TEAM_RANK: Record<TeamLevel, number> = { STAFF: 1, MANAGER: 2, OWNER: 3 };

export interface AuthContext {
  userId: string;
  role: Role;
  /** Set for business admins; always comes from the verified token, never from the request. */
  businessId?: string;
  /** For business admins: their role on the team, checked on every request. */
  teamRole?: TeamLevel;
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext =>
  ctx.switchToHttp().getRequest().user);
