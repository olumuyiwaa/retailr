import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Length, MaxLength, ValidateNested } from "class-validator";

export const SOURCES = ["direct", "whatsapp", "instagram", "facebook", "search", "other"] as const;
export const DEVICES = ["mobile", "desktop", "tablet"] as const;
export const DAYS = [7, 30, 90, 365] as const;
export const MAX_EVENTS = 50;

export class TrackEventDto {
  @IsIn(["page", "product", "add_to_cart", "checkout", "order"]) type: "page" | "product" | "add_to_cart" | "checkout" | "order";
  @IsOptional() @IsString() @MaxLength(300) path?: string;
  @IsOptional() @IsString() @MaxLength(60) productId?: string;
  @IsOptional() @IsIn(SOURCES) source?: (typeof SOURCES)[number];
  @IsOptional() @IsIn(DEVICES) device?: (typeof DEVICES)[number];
  @IsOptional() @IsString() @MaxLength(60) country?: string;
}

export class TrackDto {
  /** A business id, or "platform" for the marketing site. */
  @IsString() @Length(3, 60) scope: string;
  @IsString() @Length(8, 80) visitorId: string;
  @IsString() @Length(8, 80) sessionId: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_EVENTS) @ValidateNested({ each: true }) @Type(() => TrackEventDto) events: TrackEventDto[];
}

export class AnalyticsQuery {
  @IsOptional() @Type(() => Number) @IsInt() @IsIn(DAYS as unknown as number[], { message: "Choose 7, 30, 90 or 365 days." }) days?: number;
}
