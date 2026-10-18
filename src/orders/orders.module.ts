import { Module } from "@nestjs/common";
import { BusinessModule } from "../business/business.module";
import { OrderEngine } from "./order-engine.service";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";

@Module({ imports: [BusinessModule], controllers: [OrdersController], providers: [OrderEngine, OrdersService], exports: [OrderEngine] })
export class OrdersModule {}
