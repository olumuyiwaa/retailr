import { Module } from "@nestjs/common";
import { CatalogueController } from "./catalogue.controller";
import { CategoriesService } from "./categories.service";
import { ProductsService } from "./products.service";

@Module({ controllers: [CatalogueController], providers: [CategoriesService, ProductsService] })
export class CatalogueModule {}
