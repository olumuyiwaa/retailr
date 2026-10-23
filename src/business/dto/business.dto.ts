import { Type } from "class-transformer";
import { ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsDefined, IsEmail, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, MaxLength, Min, ValidateIf, ValidateNested } from "class-validator";

export const THEME_IDS = ["classic", "showcase", "atelier", "market", "shop", "bazaar"] as const;

export class CouponDto {
  @IsString({ message: "Use 3–20 letters, numbers or dashes for the code." }) code: string;
  @IsIn(["percent", "fixed"]) type: "percent" | "fixed";
  @IsNumber({}, { message: "Enter a discount greater than zero." }) value: number;
  @IsOptional() @IsNumber() @Min(0) minOrder?: number | null;
  @IsOptional() @IsInt() @Min(1) maxUses?: number | null;
  @IsOptional() @IsString() expiresAt?: string | null;
}
export class CouponStatusDto { @IsIn(["active", "disabled"]) status: "active" | "disabled"; }

export class RuleDto {
  @IsString() type: string;
  @IsDefined() value: unknown;
}
export class GroupDto {
  @IsString({ message: "Give the group a name." }) @MaxLength(80) name: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsIn(["manual", "auto"]) kind: "manual" | "auto";
  @IsOptional() memberIds?: string[];
  @IsOptional() @IsObject() @ValidateNested() @Type(() => RuleDto) rule?: RuleDto;
}

export class AudienceQuery {
  @IsIn(["all", "group"]) type: "all" | "group";
  @IsOptional() @IsString() groupId?: string;
  @IsIn(["email", "sms"], { message: "Choose email or SMS." }) channel: "email" | "sms";
}
export class AudienceDto {
  @IsIn(["all", "group"]) type: "all" | "group";
  @IsOptional() @IsString() groupId?: string;
}
export class SendMessageDto {
  @IsIn(["email", "sms"], { message: "Choose email or SMS." }) channel: "email" | "sms";
  @IsOptional() @IsString() @MaxLength(200) subject?: string;
  @IsString({ message: "Write a message first." }) @MaxLength(5000) body: string;
  @ValidateNested() @Type(() => AudienceDto) audience: AudienceDto;
}

export class InviteDto {
  @IsString() @MaxLength(100) name: string;
  @IsEmail({}, { message: "Enter a valid email address." }) email: string;
  @IsIn(["manager", "staff"], { message: "Choose manager or staff." }) role: "manager" | "staff";
}

export class BankAccountDto {
  @IsString() @MaxLength(80) bankName: string;
  @IsString() @MaxLength(34) accountNumber: string;
  @IsString() @MaxLength(100) accountName: string;
  @IsOptional() @IsString() @MaxLength(500) instructions?: string;
  @IsOptional() @IsString() @MaxLength(80) branch?: string;
  @IsOptional() @IsString() @MaxLength(20) sortCode?: string;
  @IsOptional() @IsString() @MaxLength(20) swiftCode?: string;
  @IsOptional() @IsString() @MaxLength(34) iban?: string;
}

export class ProfileDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(80) country?: string;
  @IsOptional() @IsString() @MaxLength(80) city?: string;
  @IsOptional() @IsString() @MaxLength(80) category?: string;
  @IsOptional() @IsString() brandColor?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1, { message: "Offer at least one way to pay." }) @ArrayUnique() @IsIn(["cod", "bank", "card"], { each: true, message: "Choose from pay on delivery, bank transfer or card." }) paymentMethods?: ("cod" | "bank" | "card")[];
  /** The account customers transfer to. Send null to remove it (only while bank transfer is switched off). */
  @IsOptional() @ValidateIf((o) => o.bankAccount !== null) @ValidateNested() @Type(() => BankAccountDto) bankAccount?: BankAccountDto | null;
  @IsOptional() @IsIn(["NGN", "GHS", "KES", "USD"]) currency?: "NGN" | "GHS" | "KES" | "USD";
  @ValidateIf((o) => o.theme !== undefined && o.theme !== null) @IsIn(THEME_IDS as unknown as string[], { message: "Choose one of the available themes." }) theme?: string | null;
  @IsOptional() @ValidateIf((o) => o.logo !== null) @IsString() logo?: string | null;
}
