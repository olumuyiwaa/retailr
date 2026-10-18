import { Module } from "@nestjs/common";
import { OrdersModule } from "../orders/orders.module";
import { StoreController } from "./store.controller";
import { StoreService } from "./store.service";

@Module({ imports: [OrdersModule], controllers: [StoreController], providers: [StoreService] })
export class StoreModule {}
