import { Transform, Type } from "class-transformer";
import { IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from "class-validator";

export class CreateCategoryDto {
  @IsString({ message: "Enter a category name." }) name: string;
  @IsOptional() @IsString() image?: string;
}

export class UpdateCategoryDto {
  @IsOptional() @IsString() name?: string;
  /** A URL to set, null to remove, omitted to keep. */
  @IsOptional() @IsString() image?: string | null;
}

export class VariantDto {
  @IsOptional() @IsString() id?: string;
  @IsString({ message: "Every variant needs a name." }) name: string;
  @IsOptional() @IsNumber() price?: number;
  @IsNumber() stock: number;
}

export class SpecDto {
  @IsString({ message: "Each product detail needs both a name and a value." }) label: string;
  @IsString({ message: "Each product detail needs both a name and a value." }) value: string;
}

export class ProductDto {
  @IsString() @MaxLength(160, { message: "Keep product names under 160 characters." }) name: string;
  @IsOptional() @IsString() @MaxLength(60) sku?: string;
  /** The name of one of the business's own categories; blank for none. */
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsNumber({}, { message: "Enter a valid price." }) @Min(0, { message: "Enter a valid price." }) price: number;
  @IsNumber() stock: number;
  @IsIn(["active", "draft", "out_of_stock"]) status: "active" | "draft" | "out_of_stock";
  /** Photo URLs from /business/uploads, cover first. Omit to keep, [] to remove all. */
  @IsOptional() @IsArray() @IsString({ each: true }) images?: string[];
  /** PUT replaces the variants: omit or send [] for none. Include `id` to keep an existing variant. */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VariantDto) variants?: VariantDto[];
  /** Omit to keep, [] to clear. */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SpecDto) specs?: SpecDto[];
}

export class ListProductsQuery {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsIn(["active", "draft", "out_of_stock"]) status?: "active" | "draft" | "out_of_stock";
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}
