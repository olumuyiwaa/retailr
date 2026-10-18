import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, MaxLength, ValidateNested } from "class-validator";
import { PageQuery } from "../../common/paging";

export const BUSINESS_STATUSES = ["active", "trial", "pending", "suspended", "cancelled"] as const;

export class BusinessesQuery extends PageQuery {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsIn(BUSINESS_STATUSES) status?: (typeof BUSINESS_STATUSES)[number];
  @IsOptional() @IsString() planId?: string;
}
export class SubscriptionsQuery extends PageQuery {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsIn(["active", "trialing", "past_due", "cancelled"]) status?: string;
}
export class InvoicesQuery extends PageQuery {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsIn(["paid", "pending", "failed", "refunded"]) status?: string;
}
export class BusinessStatusDto { @IsIn(BUSINESS_STATUSES) status: (typeof BUSINESS_STATUSES)[number]; }

export class LimitsDto {
  @IsNumber() products: number;
  @IsNumber() staff: number;
  @IsNumber() ordersPerMonth: number;
  @IsNumber() storageGb: number;
}
export class PlanDto {
  @IsString({ message: "Enter a plan name." }) @MaxLength(60) name: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsNumber({}, { message: "Prices can't be negative." }) priceMonthly: number;
  @IsNumber({}, { message: "Prices can't be negative." }) priceYearly: number;
  @IsOptional() @IsNumber() transactionFeePct?: number;
  @ValidateNested() @Type(() => LimitsDto) limits: LimitsDto;
  @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) features: string[];
  @IsOptional() @IsBoolean() highlighted?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() localPrices?: Record<string, { monthly: number; yearly: number }>;
}

export class PlanCouponDto {
  @IsString({ message: "Use 3–20 letters, numbers or dashes for the code." }) code: string;
  @IsIn(["percent", "fixed"]) type: "percent" | "fixed";
  @IsNumber({}, { message: "Enter a discount greater than zero." }) value: number;
  @IsOptional() @IsArray() @IsString({ each: true }) planIds?: string[];
  @IsOptional() @IsString() businessId?: string | null;
  @IsOptional() @IsNumber() maxUses?: number | null;
  @IsOptional() @IsString() expiresAt?: string | null;
  @IsOptional() @IsString() @MaxLength(300) note?: string | null;
}
export class PlanCouponStatusDto { @IsIn(["active", "disabled"]) status: "active" | "disabled"; }
