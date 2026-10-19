import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional } from "class-validator";
import { AuthContext, CurrentUser, Roles, MinRole } from "../common/decorators";
import { REPORT_DAYS, ReportsService } from "./reports.service";

export class ReportQuery {
  @IsOptional() @Type(() => Number) @IsInt() @IsIn(REPORT_DAYS as unknown as number[], { message: "Choose 7, 30, 90 or 365 days." }) days?: number;
}

@ApiTags("reports")
@ApiBearerAuth()
@Roles("BUSINESS_ADMIN")
@Controller("business")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}
  @Get("overview") overview(@CurrentUser() u: AuthContext) { return this.reports.overview(u.businessId!); }
  @MinRole("MANAGER") @Get("reports/sales") sales(@CurrentUser() u: AuthContext, @Query() q: ReportQuery) { return this.reports.sales(u.businessId!, q.days ?? 30); }
}
