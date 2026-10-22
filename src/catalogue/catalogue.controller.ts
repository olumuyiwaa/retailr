import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { AuthContext, CurrentUser, Roles, MinRole } from "../common/decorators";
import { CategoriesService } from "./categories.service";
import { CreateCategoryDto, ListProductsQuery, ListServicesQuery, ProductDto, ServiceDto, UpdateCategoryDto } from "./dto/catalogue.dto";
import { ProductsService } from "./products.service";
import { ServicesService } from "./services.service";

@ApiTags("catalogue")
@ApiBearerAuth()
@Roles("BUSINESS_ADMIN")
@Controller("business")
export class CatalogueController {
  constructor(private readonly categories: CategoriesService, private readonly products: ProductsService, private readonly services: ServicesService) {}

  @Get("categories") listCategories(@CurrentUser() u: AuthContext) { return this.categories.list(u.businessId!); }
  @MinRole("MANAGER")  @Post("categories") createCategory(@CurrentUser() u: AuthContext, @Body() dto: CreateCategoryDto) { return this.categories.create(u.businessId!, dto.name, dto.image); }
  @MinRole("MANAGER")  @Patch("categories/:id") updateCategory(@CurrentUser() u: AuthContext, @Param("id") id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(u.businessId!, id, { name: dto.name, image: dto.image });
  }
  @MinRole("MANAGER")  @Delete("categories/:id") deleteCategory(@CurrentUser() u: AuthContext, @Param("id") id: string) { return this.categories.remove(u.businessId!, id); }

  /** The page of products is the response body; the total across all pages is in the X-Total-Count header. */
  @Get("products")
  async listProducts(@CurrentUser() u: AuthContext, @Query() q: ListProductsQuery, @Res({ passthrough: true }) res: Response) {
    const { items, total } = await this.products.list(u.businessId!, q);
    res.setHeader("X-Total-Count", String(total));
    res.setHeader("Access-Control-Expose-Headers", "X-Total-Count");
    return items;
  }
  @Get("products/:id") getProduct(@CurrentUser() u: AuthContext, @Param("id") id: string) { return this.products.get(u.businessId!, id); }
  @MinRole("MANAGER")  @Post("products") createProduct(@CurrentUser() u: AuthContext, @Body() dto: ProductDto) { return this.products.create(u.businessId!, dto); }
  @MinRole("MANAGER")  @Put("products/:id") updateProduct(@CurrentUser() u: AuthContext, @Param("id") id: string, @Body() dto: ProductDto) { return this.products.update(u.businessId!, id, dto); }
  @MinRole("MANAGER")  @HttpCode(204) @Delete("products/:id") async deleteProduct(@CurrentUser() u: AuthContext, @Param("id") id: string) { await this.products.remove(u.businessId!, id); }

  @Get("services")
  async listServices(@CurrentUser() u: AuthContext, @Query() q: ListServicesQuery, @Res({ passthrough: true }) res: Response) {
    const { items, total } = await this.services.list(u.businessId!, q);
    res.setHeader("X-Total-Count", String(total));
    res.setHeader("Access-Control-Expose-Headers", "X-Total-Count");
    return items;
  }
  @Get("services/:id") getService(@CurrentUser() u: AuthContext, @Param("id") id: string) { return this.services.get(u.businessId!, id); }
  @MinRole("MANAGER")  @Post("services") createService(@CurrentUser() u: AuthContext, @Body() dto: ServiceDto) { return this.services.create(u.businessId!, dto); }
  @MinRole("MANAGER")  @Put("services/:id") updateService(@CurrentUser() u: AuthContext, @Param("id") id: string, @Body() dto: ServiceDto) { return this.services.update(u.businessId!, id, dto); }
  @MinRole("MANAGER")  @HttpCode(204) @Delete("services/:id") async deleteService(@CurrentUser() u: AuthContext, @Param("id") id: string) { await this.services.remove(u.businessId!, id); }
}
