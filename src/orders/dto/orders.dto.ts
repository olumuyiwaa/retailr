import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from "class-validator";

export const ORDER_STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled", "refunded"] as const;
export const CHANNELS = ["online", "in_store", "whatsapp", "instagram", "phone", "other"] as const;

export class ListOrdersQuery {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsIn(ORDER_STATUSES) status?: (typeof ORDER_STATUSES)[number];
  @IsOptional() @IsIn(["paid", "unpaid", "refunded"]) paymentStatus?: "paid" | "unpaid" | "refunded";
  @IsOptional() @IsIn(CHANNELS) channel?: (typeof CHANNELS)[number];
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class UpdateOrderStatusDto {
  @IsIn(ORDER_STATUSES) status: (typeof ORDER_STATUSES)[number];
}

export class SaleLineDto {
  @IsOptional() @IsString() productId?: string;
  @IsOptional() @IsString() variantId?: string;
  @IsOptional() @IsString() serviceId?: string;
  @IsOptional() @IsString() optionId?: string;
  @IsNumber() qty: number;
  @IsOptional() @IsNumber() price?: number;
}

export class NewCustomerDto {
  @IsString() name: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(254) email?: string;
}

export class RecordSaleDto {
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @ValidateNested() @Type(() => NewCustomerDto) newCustomer?: NewCustomerDto;
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => SaleLineDto) items: SaleLineDto[];
  @IsIn(["in_store", "whatsapp", "instagram", "phone", "other"], { message: "Choose where the sale came from." }) channel: "in_store" | "whatsapp" | "instagram" | "phone" | "other";
  @IsIn(["cod", "bank", "card", "cash", "pos"]) paymentMethod: "cod" | "bank" | "card" | "cash" | "pos";
  /** false = the customer still owes the money */
  @IsBoolean() paid: boolean;
  /** true = goods already handed over (delivered); false = still to deliver */
  @IsBoolean() handedOver: boolean;
  @IsOptional() @IsNumber() @Min(0) discount?: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class ListCustomersQuery {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}
