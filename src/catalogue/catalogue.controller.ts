import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { AuthContext, CurrentUser, Roles } from "../common/decorators";
import { CategoriesService } from "./categories.service";
import { CreateCategoryDto, ListProductsQuery, ProductDto, UpdateCategoryDto } from "./dto/catalogue.dto";
import { ProductsService } from "./products.service";

@ApiTags("catalogue")
@ApiBearerAuth()
@Roles("BUSINESS_ADMIN")
@Controller("business")
export class CatalogueController {
  constructor(private readonly categories: CategoriesService, private readonly products: ProductsService) {}

  @Get("categories") listCategories(@CurrentUser() u: AuthContext) { return this.categories.list(u.businessId!); }
  @Post("categories") createCategory(@CurrentUser() u: AuthContext, @Body() dto: CreateCategoryDto) { return this.categories.create(u.businessId!, dto.name, dto.image); }
  @Patch("categories/:id") updateCategory(@CurrentUser() u: AuthContext, @Param("id") id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(u.businessId!, id, { name: dto.name, image: dto.image });
  }
  @Delete("categories/:id") deleteCategory(@CurrentUser() u: AuthContext, @Param("id") id: string) { return this.categories.remove(u.businessId!, id); }

  /** The page of products is the response body; the total across all pages is in the X-Total-Count header. */
  @Get("products")
  async listProducts(@CurrentUser() u: AuthContext, @Query() q: ListProductsQuery, @Res({ passthrough: true }) res: Response) {
    const { items, total } = await this.products.list(u.businessId!, q);
    res.setHeader("X-Total-Count", String(total));
    res.setHeader("Access-Control-Expose-Headers", "X-Total-Count");
    return items;
  }
  @Get("products/:id") getProduct(@CurrentUser() u: AuthContext, @Param("id") id: string) { return this.products.get(u.businessId!, id); }
  @Post("products") createProduct(@CurrentUser() u: AuthContext, @Body() dto: ProductDto) { return this.products.create(u.businessId!, dto); }
  @Put("products/:id") updateProduct(@CurrentUser() u: AuthContext, @Param("id") id: string, @Body() dto: ProductDto) { return this.products.update(u.businessId!, id, dto); }
  @HttpCode(204) @Delete("products/:id") async deleteProduct(@CurrentUser() u: AuthContext, @Param("id") id: string) { await this.products.remove(u.businessId!, id); }
}
