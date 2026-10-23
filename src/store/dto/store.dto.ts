import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateNested } from "class-validator";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class CartLineDto {
  /** A line is a product or a service: send exactly one of productId / serviceId. */
  @IsOptional() @IsString() productId?: string;
  @IsOptional() @IsString() variantId?: string;
  @IsOptional() @IsString() serviceId?: string;
  @IsOptional() @IsString() optionId?: string;
  @IsNumber({}, { message: "Invalid quantity." }) qty: number;
}

export class CheckoutCustomerDto {
  @Transform(trim) @IsString() @Length(1, 100, { message: "Please enter your name." }) name: string;
  @Transform(trim) @IsEmail({}, { message: "Enter a valid email address." }) @MaxLength(254) email: string;
  @Transform(trim) @IsString() @Length(1, 40, { message: "Please enter your phone number." }) phone: string;
}

export class PlaceOrderDto {
  @ValidateNested() @Type(() => CheckoutCustomerDto) customer: CheckoutCustomerDto;
  /** Required unless the shopper picks pickup; checked in the order engine. */
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) shippingAddress?: string;
  @IsOptional() @IsIn(["delivery", "pickup"]) deliveryMethod?: "delivery" | "pickup";
  @IsOptional() @IsString() @MaxLength(60) deliveryZoneId?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsIn(["cod", "bank", "card"], { message: "Choose how you'd like to pay." }) paymentMethod: "cod" | "bank" | "card";
  @IsOptional() @IsString() @MaxLength(30) couponCode?: string;
  @IsArray() @ArrayMinSize(1, { message: "Your cart is empty." }) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => CartLineDto) items: CartLineDto[];
}

export class ValidateCouponDto {
  @IsString() code: string;
  @IsNumber() @Min(0) subtotal: number;
}
