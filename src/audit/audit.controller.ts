import { Controller, Get, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";
import type { Response } from "express";
import { AuthContext, CurrentUser, MinRole, Roles } from "../common/decorators";
import { PageQuery, withTotal } from "../common/paging";
import { AuditService } from "./audit.service";

export class AuditQuery extends PageQuery {
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() businessId?: string;
}

@ApiTags("audit")
@ApiBearerAuth()
@Controller()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** A business sees only its own history. */
  @Roles("BUSINESS_ADMIN") @MinRole("OWNER") @Get("business/audit")
  async mine(@CurrentUser() u: AuthContext, @Query() q: AuditQuery, @Res({ passthrough: true }) res: Response) {
    const r = await this.audit.list({ businessId: u.businessId!, ...(q.action ? { action: { contains: q.action, mode: "insensitive" } } : {}) }, q.page ?? 1, q.limit ?? 50);
    withTotal(res, r.total); return r.items;
  }

  @Roles("SUPER_ADMIN") @Get("platform/audit")
  async all(@Query() q: AuditQuery, @Res({ passthrough: true }) res: Response) {
    const r = await this.audit.list({ ...(q.businessId ? { businessId: q.businessId } : {}), ...(q.action ? { action: { contains: q.action, mode: "insensitive" } } : {}) }, q.page ?? 1, q.limit ?? 50);
    withTotal(res, r.total); return r.items;
  }
}
