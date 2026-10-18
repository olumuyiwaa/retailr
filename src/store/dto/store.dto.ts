import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateNested } from "class-validator";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class CartLineDto {
  @IsString() productId: string;
  @IsOptional() @IsString() variantId?: string;
  @IsNumber({}, { message: "Invalid quantity." }) qty: number;
}

export class CheckoutCustomerDto {
  @Transform(trim) @IsString() @Length(1, 100, { message: "Please enter your name." }) name: string;
  @Transform(trim) @IsEmail({}, { message: "Enter a valid email address." }) @MaxLength(254) email: string;
  @Transform(trim) @IsString() @Length(1, 40, { message: "Please enter your phone number." }) phone: string;
}

export class PlaceOrderDto {
  @ValidateNested() @Type(() => CheckoutCustomerDto) customer: CheckoutCustomerDto;
  @Transform(trim) @IsString() @Length(1, 500, { message: "Please enter your delivery address." }) shippingAddress: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsIn(["cod", "bank", "card"], { message: "Choose how you'd like to pay." }) paymentMethod: "cod" | "bank" | "card";
  @IsOptional() @IsString() @MaxLength(30) couponCode?: string;
  @IsArray() @ArrayMinSize(1, { message: "Your cart is empty." }) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => CartLineDto) items: CartLineDto[];
}

export class ValidateCouponDto {
  @IsString() code: string;
  @IsNumber() @Min(0) subtotal: number;
}
