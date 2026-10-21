import { Transform, Type } from "class-transformer";
import { IsBoolean, IsEmail, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateNested } from "class-validator";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class BookingSettingsDto {
  @IsString() @MaxLength(60) timezone: string;
  /** { mon: [{ start: "09:00", end: "17:00" }], ... } — days left out are closed. */
  @IsObject() hours: Record<string, { start: string; end: string }[]>;
  @IsInt() @Min(0) @Max(168) noticeHours: number;
  @IsBoolean() autoConfirm: boolean;
}

export class BookingCustomerDto {
  @Transform(trim) @IsString() @Length(1, 100, { message: "Please enter your name." }) name: string;
  @Transform(trim) @IsEmail({}, { message: "Enter a valid email address." }) @MaxLength(254) email: string;
  @Transform(trim) @IsString() @Length(1, 40, { message: "Please enter your phone number." }) phone: string;
}

export class NewBookingDto {
  @IsString() productId: string;
  @IsOptional() @IsString() variantId?: string;
  /** ISO time from the slots list. */
  @IsString() startsAt: string;
  @ValidateNested() @Type(() => BookingCustomerDto) customer: BookingCustomerDto;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class AdminCustomerDto {
  @Transform(trim) @IsString() @Length(1, 100, { message: "Enter the customer's name." }) name: string;
  @Transform(trim) @IsOptional() @IsEmail({}, { message: "Enter a valid email address, or leave it blank." }) @MaxLength(254) email?: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(40) phone?: string;
}

export class AdminBookingDto {
  @IsString() productId: string;
  @IsOptional() @IsString() variantId?: string;
  @IsString() startsAt: string;
  @ValidateNested() @Type(() => AdminCustomerDto) customer: AdminCustomerDto;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class BookingStatusDto {
  @IsIn(["confirmed", "completed", "cancelled", "no_show"]) status: "confirmed" | "completed" | "cancelled" | "no_show";
}

export class ListBookingsQuery {
  @IsOptional() @IsIn(["pending", "confirmed", "completed", "cancelled", "no_show"]) status?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsString() q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

export class SlotsQuery {
  @IsString() date: string;
}
